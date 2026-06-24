/**
 * Слой доступа к таблице `shop_settings` (docs/11 §5.4).
 *
 * ТОЛЬКО shop_settings: чтение всех/одного ключа, upsert, delete (reset к
 * env-дефолту). Все запросы параметризованы через `sql` (tagged templates,
 * анти-SQLi). Бизнес-валидация значений — в schemas.ts; здесь лишь персист.
 *
 * Это обычный модуль (не 'use server'): мутации обёртываются в defineAction в
 * lib/settings/actions.ts (пакет 5.D-2), а репозиторий вызывается из handler.
 */

import { sql } from '@/lib/db/client';

/** Строка таблицы shop_settings (raw row). */
export interface ShopSettingRow {
  setting_key: string;
  value: Record<string, unknown>;
  updated_at: Date;
  updated_by: string | null;
}

/** Минимальная форма строки для merge-слоя (ключ + значение). */
export interface SettingRow {
  setting_key: string;
  value: Record<string, unknown>;
}

/** Нормализует JSONB-значение в объект (postgres.js обычно отдаёт уже объектом). */
function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore — вернём пустой объект ниже */
    }
  }
  return {};
}

/**
 * Все строки настроек (ключ + значение) — вход для mergeSettings.
 * Возвращает только setting_key/value (минимум для merge-слоя).
 */
export async function getAllSettings(): Promise<SettingRow[]> {
  const rows = await sql<{ setting_key: string; value: unknown }[]>`
    SELECT setting_key, value FROM shop_settings
  `;
  return rows.map((r) => ({ setting_key: r.setting_key, value: asObject(r.value) }));
}

/** Одна строка настроек по ключу (полная, с audit-trail). */
export async function getSetting(key: string): Promise<ShopSettingRow | null> {
  const rows = await sql<
    { setting_key: string; value: unknown; updated_at: Date; updated_by: string | null }[]
  >`
    SELECT setting_key, value, updated_at, updated_by
    FROM shop_settings WHERE setting_key = ${key} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    setting_key: row.setting_key,
    value: asObject(row.value),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    updated_by: row.updated_by ?? null,
  };
}

/**
 * UPSERT значения ключа. `value` — уже провалидированный Zod-объект (вызывающий
 * action обязан валидировать схемой ключа ДО записи). `updatedBy` — id автора
 * правки (audit-trail на строке). Возвращает записанную строку.
 */
export async function upsertSetting(
  key: string,
  value: Record<string, unknown>,
  updatedBy: string | null,
): Promise<ShopSettingRow> {
  const json = sql.json(value as Record<string, never>);
  const rows = await sql<
    { setting_key: string; value: unknown; updated_at: Date; updated_by: string | null }[]
  >`
    INSERT INTO shop_settings (setting_key, value, updated_at, updated_by)
    VALUES (${key}, ${json}, now(), ${updatedBy})
    ON CONFLICT (setting_key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
    RETURNING setting_key, value, updated_at, updated_by
  `;
  const row = rows[0]!;
  return {
    setting_key: row.setting_key,
    value: asObject(row.value),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    updated_by: row.updated_by ?? null,
  };
}

/**
 * Удаляет строку ключа → возврат к env-дефолту (reset). Возвращает true, если
 * строка существовала и была удалена.
 */
export async function deleteSetting(key: string): Promise<boolean> {
  const rows = await sql<{ setting_key: string }[]>`
    DELETE FROM shop_settings WHERE setting_key = ${key} RETURNING setting_key
  `;
  return rows.length > 0;
}
