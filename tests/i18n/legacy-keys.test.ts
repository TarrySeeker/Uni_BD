import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listMigrations } from '@/lib/db/migrate';
import {
  LEGACY_KEY_ALIASES,
  normalizeLegacyTranslationKeys,
  toSnakeCase,
} from '@/lib/i18n/legacy-keys';

/**
 * T1 — оживление мёртвых SEO-переводов (миграция 0055).
 *
 * Дефект данных: ETL прошлых сессий залил в оверлей translations ключи в
 * snake_case (seo_title/seo_description), а whitelist lib/i18n/fields.ts читает
 * camelCase (seoTitle/seoDescription) → ~1030 переводов на стенде (products, en+fr)
 * невидимы и админке, и витрине.
 *
 * (а) ЮНИТ — чистая функция переименования ключей оверлея.
 * (б) GUARD — миграция 0055 и запрет антипаттерна snake_case в ETL-скриптах.
 */

const ROOT = path.resolve(__dirname, '..', '..');

function stripSqlComments(s: string): string {
  return s.replace(/--[^\n]*/g, '');
}

// =============================================================================
// (а) ЮНИТ — карта алиасов.
// =============================================================================
describe('i18n/legacy-keys — карта алиасов', () => {
  it('toSnakeCase переводит camelCase в snake_case и не трогает односложные', () => {
    expect(toSnakeCase('seoTitle')).toBe('seo_title');
    expect(toSnakeCase('ogDescription')).toBe('og_description');
    expect(toSnakeCase('name')).toBe('name');
    expect(toSnakeCase('description')).toBe('description');
  });

  it('алиасы покрывают все реально пострадавшие SEO/OG-ключи', () => {
    expect(LEGACY_KEY_ALIASES['seo_title']).toBe('seoTitle');
    expect(LEGACY_KEY_ALIASES['seo_description']).toBe('seoDescription');
    expect(LEGACY_KEY_ALIASES['og_title']).toBe('ogTitle');
    expect(LEGACY_KEY_ALIASES['og_description']).toBe('ogDescription');
  });

  it('односложные поля whitelist в карту НЕ попадают (переименовывать нечего)', () => {
    expect(LEGACY_KEY_ALIASES['name']).toBeUndefined();
    expect(LEGACY_KEY_ALIASES['description']).toBeUndefined();
    expect(LEGACY_KEY_ALIASES['title']).toBeUndefined();
    expect(LEGACY_KEY_ALIASES['body']).toBeUndefined();
  });

  it('карта выводится из whitelist полей: ключ — snake, значение — камель из whitelist', () => {
    for (const [snake, camel] of Object.entries(LEGACY_KEY_ALIASES)) {
      expect(toSnakeCase(camel)).toBe(snake);
      expect(snake).not.toBe(camel);
    }
  });
});

// =============================================================================
// (а) ЮНИТ — normalizeLegacyTranslationKeys.
// =============================================================================
describe('i18n/legacy-keys — normalizeLegacyTranslationKeys', () => {
  it('голый snake_case: ключи переименованы в camelCase, значения сохранены', () => {
    const r = normalizeLegacyTranslationKeys({
      en: { name: 'Scarf', seo_title: 'T', seo_description: 'D' },
    });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ en: { name: 'Scarf', seoTitle: 'T', seoDescription: 'D' } });
    expect(r.value.en).not.toHaveProperty('seo_title');
  });

  it('смешанное состояние: camelCase выигрывает, snake_case НЕ теряется', () => {
    const r = normalizeLegacyTranslationKeys({
      en: { seo_title: 'ETL', seoTitle: 'Owner' },
    });
    expect(r.value.en.seoTitle).toBe('Owner');
    expect(r.value.en.seo_title).toBe('ETL');
    expect(r.changed).toBe(false);
  });

  it('идемпотентность: повторный прогон ничего не меняет', () => {
    const once = normalizeLegacyTranslationKeys({
      en: { seo_title: 'T' },
      fr: { seo_title: 'X', seoTitle: 'Y' },
    });
    const twice = normalizeLegacyTranslationKeys(once.value);
    expect(twice.changed).toBe(false);
    expect(twice.value).toEqual(once.value);
  });

  it('пустой оверлей: null / undefined / {} → {} без изменений', () => {
    expect(normalizeLegacyTranslationKeys(null)).toEqual({ changed: false, value: {} });
    expect(normalizeLegacyTranslationKeys(undefined)).toEqual({ changed: false, value: {} });
    expect(normalizeLegacyTranslationKeys({})).toEqual({ changed: false, value: {} });
    expect(normalizeLegacyTranslationKeys({ en: {} })).toEqual({
      changed: false,
      value: { en: {} },
    });
  });

  it('неизвестные ключи не трогаются', () => {
    const r = normalizeLegacyTranslationKeys({
      en: { some_custom_key: 'v', anotherKey: 'w', tabs: [{ title: 'a' }] },
    });
    expect(r.changed).toBe(false);
    expect(r.value.en).toEqual({ some_custom_key: 'v', anotherKey: 'w', tabs: [{ title: 'a' }] });
  });

  it('языки не перепутаны: каждый оверлей нормализуется независимо', () => {
    const r = normalizeLegacyTranslationKeys({
      en: { seo_title: 'EN' },
      fr: { seo_description: 'FR' },
      de: { name: 'DE' },
    });
    expect(r.value).toEqual({
      en: { seoTitle: 'EN' },
      fr: { seoDescription: 'FR' },
      de: { name: 'DE' },
    });
  });

  it('иммутабельность: исходный объект не мутируется', () => {
    const src = { en: { seo_title: 'T' } };
    const r = normalizeLegacyTranslationKeys(src);
    expect(src).toEqual({ en: { seo_title: 'T' } });
    expect(r.value).not.toBe(src);
  });

  it('не-объектное значение языка проходит насквозь без падения', () => {
    const r = normalizeLegacyTranslationKeys({ en: 'broken' as unknown as Record<string, unknown> });
    expect(r.changed).toBe(false);
    expect(r.value.en).toBe('broken');
  });

  it('нестроковые значения переносятся как есть (перенос ключа, не значения)', () => {
    const r = normalizeLegacyTranslationKeys({ en: { seo_title: 42, seo_description: null } });
    expect(r.value.en).toEqual({ seoTitle: 42, seoDescription: null });
  });
});

// =============================================================================
// (б) GUARD — миграция 0055.
// =============================================================================
describe('db/migrations — 0055 (guard)', () => {
  async function get0055() {
    const all = await listMigrations();
    return all.find((m) => m.version === '0055');
  }

  it('файл 0055 существует', async () => {
    expect(await get0055()).toBeDefined();
  });

  it('пишет свою версию в schema_migrations с ON CONFLICT DO NOTHING', async () => {
    const m = await get0055();
    const sqlText = await readFile(m!.path, 'utf8');
    expect(sqlText).toContain('schema_migrations');
    expect(sqlText).toContain("'0055'");
    expect(sqlText.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
  });

  it('переименовывает ровно те же ключи, что и чистая функция', async () => {
    const m = await get0055();
    const sqlText = stripSqlComments(await readFile(m!.path, 'utf8'));
    for (const [snake, camel] of Object.entries(LEGACY_KEY_ALIASES)) {
      expect(sqlText, `нет пары ${snake}→${camel}`).toContain(`'${snake}'`);
      expect(sqlText).toContain(`'${camel}'`);
    }
  });

  it('идемпотентна: не переносит ключ, если camelCase уже занят (защита от потери данных)', async () => {
    const m = await get0055();
    const sql = stripSqlComments(await readFile(m!.path, 'utf8'));
    // Механизм ЕСТЬ: перенос обусловлен отсутствием camelCase-ключа (оператор ?).
    expect(sql).toMatch(/NOT\s*\(\s*[a-z_.]+\s*\?\s*[a-z_.]+\.camel\s*\)/i);
    // Антипаттерн ЗАПРЕЩЁН: безусловное затирание оверлея целиком.
    expect(sql).not.toMatch(/SET\s+translations\s*=\s*'/i);
  });

  it('не трогает схему: только UPDATE/INSERT данных, без DDL-деструктива', async () => {
    const m = await get0055();
    const upper = stripSqlComments(await readFile(m!.path, 'utf8')).toUpperCase();
    expect(upper).toContain('UPDATE');
    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'DELETE FROM']) {
      expect(upper, `запрещено ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('обходит таблицы через to_regclass — отсутствующая таблица модуля не роняет накат', async () => {
    const m = await get0055();
    const sql = stripSqlComments(await readFile(m!.path, 'utf8'));
    expect(sql).toContain('to_regclass');
  });
});

// =============================================================================
// (б) GUARD — источник дефекта: ETL не должен писать snake_case в translations.
// =============================================================================
describe('guard — ETL не пишет snake_case-ключи в оверлей translations', () => {
  async function collect(dir: string, exts: string[], acc: string[] = []): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.next' || e.startsWith('.')) continue;
      const full = path.join(dir, e);
      const st = await stat(full);
      if (st.isDirectory()) await collect(full, exts, acc);
      else if (exts.some((x) => e.endsWith(x))) acc.push(full);
    }
    return acc;
  }

  it('ни один файл scripts/ не сочетает translations со snake_case SEO-ключом', async () => {
    const files = await collect(path.join(ROOT, 'scripts'), ['.mjs', '.js', '.ts', '.sh']);
    const legacy = Object.keys(LEGACY_KEY_ALIASES);
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      if (!src.includes('translations')) continue;
      for (const k of legacy) {
        if (new RegExp(`['"\`]${k}['"\`]`).test(src)) offenders.push(`${path.basename(f)}:${k}`);
      }
    }
    expect(offenders, `ETL пишет мёртвые ключи: ${offenders.join(', ')}`).toEqual([]);
  });

  it('нормализатор доступен из публичного API lib/i18n (чтобы будущий ETL им пользовался)', async () => {
    const src = await readFile(path.join(ROOT, 'lib', 'i18n', 'index.ts'), 'utf8');
    expect(src).toContain('normalizeLegacyTranslationKeys');
    expect(src).toContain('LEGACY_KEY_ALIASES');
  });
});
