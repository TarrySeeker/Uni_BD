/**
 * Конфигурация языков магазина (ADR-i18n, docs/24 §1).
 *
 * getLocaleConfig() читает shop_settings.i18n (сид — миграция 0036); при
 * отсутствии/битом значении — env-дефолт DEFAULT_LOCALE_CONFIG (ru + [ru,en,fr]).
 * resolveRequestLocale() валидирует членство запрошенного языка в наборе, иначе
 * возвращает язык по умолчанию (fail-safe: никогда не бросает, всегда отдаёт
 * валидный locale из набора).
 *
 * Чистый домен: parseLocaleConfig/resolveRequestLocale — без БД/Next, тестируемы
 * напрямую. getLocaleConfig изолирует чтение БД за инъектируемым reader'ом.
 */

import { z } from 'zod';

import { normalizeLocale } from './locale-token';
import type { Locale, LocaleConfig } from './types';

/**
 * Ре-экспорт для обратной совместимости. Клиентские модули обязаны импортировать
 * normalizeLocale из '@/lib/i18n/locale-token' напрямую: этот файл тянет БД.
 */
export { normalizeLocale };

/** Env-дефолт: применяется, когда в shop_settings.i18n нет валидной конфигурации. */
export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  defaultLocale: 'ru',
  locales: ['ru', 'en', 'fr'],
};

const localeToken = z.string().trim().min(1).max(35);

const rawConfigSchema = z.object({
  defaultLocale: localeToken,
  locales: z.array(localeToken).min(1),
});

/**
 * Валидирует и нормализует сырое значение конфигурации языков. При любой ошибке
 * (не объект, пустой список, не строки) возвращает DEFAULT_LOCALE_CONFIG.
 * Гарантирует: языки нормализованы, уникальны, defaultLocale ∈ locales.
 */
export function parseLocaleConfig(raw: unknown): LocaleConfig {
  const parsed = rawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return DEFAULT_LOCALE_CONFIG;
  }

  const defaultLocale = normalizeLocale(parsed.data.defaultLocale);

  const seen = new Set<string>();
  const locales: Locale[] = [];
  for (const l of parsed.data.locales) {
    const n = normalizeLocale(l);
    if (n && !seen.has(n)) {
      seen.add(n);
      locales.push(n);
    }
  }

  // defaultLocale обязан быть членом набора — если нет, добавляем в начало.
  if (!seen.has(defaultLocale)) {
    locales.unshift(defaultLocale);
  }

  return { defaultLocale, locales };
}

/**
 * Резолвит эффективный язык запроса: нормализует raw, проверяет членство в
 * наборе (с фолбэком на первичный subtag: 'en-US' → 'en'), иначе — defaultLocale.
 * Никогда не бросает; всегда возвращает язык из config.locales.
 */
export function resolveRequestLocale(
  raw: string | null | undefined,
  config: LocaleConfig,
): Locale {
  if (typeof raw !== 'string') {
    return config.defaultLocale;
  }

  const norm = normalizeLocale(raw);
  if (!norm) {
    return config.defaultLocale;
  }

  if (config.locales.includes(norm)) {
    return norm;
  }

  // Фолбэк на первичный subtag ('en-us' → 'en', 'fr-CA' → 'fr').
  const primary = norm.split('-')[0];
  if (primary && config.locales.includes(primary)) {
    return primary;
  }

  return config.defaultLocale;
}

/** Читатель сырого значения shop_settings.i18n (инъекция для тестов/границы). */
export type LocaleConfigReader = () => Promise<unknown>;

/**
 * Возвращает эффективную конфигурацию языков магазина. Читает shop_settings.i18n
 * (через reader — по умолчанию из репозитория настроек); при отсутствии/ошибке —
 * DEFAULT_LOCALE_CONFIG. Не бросает.
 */
export async function getLocaleConfig(reader?: LocaleConfigReader): Promise<LocaleConfig> {
  const read = reader ?? defaultReader;
  try {
    const raw = await read();
    if (raw == null) {
      return DEFAULT_LOCALE_CONFIG;
    }
    return parseLocaleConfig(raw);
  } catch {
    return DEFAULT_LOCALE_CONFIG;
  }
}

/** Продакшн-читатель: тянет shop_settings.i18n через репозиторий настроек. */
async function defaultReader(): Promise<unknown> {
  const { getSetting } = await import('@/lib/settings/repository');
  const row = await getSetting('i18n');
  return row?.value ?? null;
}
