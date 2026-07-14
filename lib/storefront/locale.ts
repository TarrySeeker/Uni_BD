/**
 * Резолв эффективного языка запроса витрины + локализация доменных строк на
 * границе storefront→DTO (ADR-i18n, docs/24 §1, инкремент 2a).
 *
 * Транспорт языка (приоритет): ?locale= → Accept-Language → default(ru).
 * Резолв не бросает: невалидный/неизвестный язык → defaultLocale магазина
 * (resolveRequestLocale валидирует членство в shop_settings.i18n.locales).
 *
 * ФОРМА DTO НЕ меняется — локализуются только ЗНАЧЕНИЯ whitelisted-полей по
 * оверлею translations доменного объекта; при отсутствии перевода — база (ru).
 */

import {
  getLocaleConfig,
  resolveRequestLocale,
  localizeRow,
} from '@/lib/i18n';
import type { Locale, LocaleConfig, TranslationsMap } from '@/lib/i18n';

/** Контекст локализации на границе мапперов: целевой язык + язык-канон. */
export interface LocalizeCtx {
  locale: Locale;
  defaultLocale: Locale;
}

/** Результат резолва языка запроса витрины. */
export interface StorefrontLocale {
  locale: Locale;
  config: LocaleConfig;
}

/**
 * Извлекает СЫРОЙ тег языка из запроса: ?locale= (кэшируемо по URL) → первый тег
 * Accept-Language → null (тогда resolveRequestLocale отдаст default). Нормализацию
 * и валидацию членства делает resolveRequestLocale (config.ts) — здесь только
 * извлечение.
 */
export function extractRawLocale(req: Request): string | null {
  let params: URLSearchParams | null = null;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    params = null;
  }
  const q = params?.get('locale');
  if (q && q.trim()) {
    return q;
  }
  const al = req.headers.get('accept-language');
  if (al && al.trim()) {
    // Первый тег списка ('en-US,en;q=0.9' → 'en-US'); q-веса игнорируем (MVP).
    const first = al.split(',')[0];
    if (first && first.trim()) {
      return first.trim();
    }
  }
  return null;
}

/**
 * Резолвит эффективный язык запроса витрины по конфигурации магазина
 * (shop_settings.i18n; env-дефолт ru+[ru,en,fr]). Fail-safe: никогда не бросает.
 */
export async function resolveStorefrontLocale(req: Request): Promise<StorefrontLocale> {
  const config = await getLocaleConfig();
  const locale = resolveRequestLocale(extractRawLocale(req), config);
  return { locale, config };
}

/** LocalizeCtx из контекста роута (locale + конфиг магазина). */
export function localizeCtxFrom(ctx: {
  locale: Locale;
  localeConfig: LocaleConfig;
}): LocalizeCtx {
  return { locale: ctx.locale, defaultLocale: ctx.localeConfig.defaultLocale };
}

/**
 * Локализует whitelisted-поля доменной строки по её собственному оверлею
 * `translations`. При loc===undefined или locale===defaultLocale возвращает
 * объект без изменений значений (та же форма). Непереводимые поля не трогаются.
 */
export function localizeEntity<R extends object>(
  entity: R & { translations?: TranslationsMap | null },
  fields: readonly (keyof R & string)[],
  loc?: LocalizeCtx,
): R {
  if (!loc) {
    return entity;
  }
  // Доменные интерфейсы не несут index-signature (в отличие от Record) — приводим
  // к Record для чистого localizeRow и обратно к R (форма/ключи не меняются).
  return localizeRow(
    entity as R & Record<string, unknown>,
    entity.translations ?? null,
    loc.locale,
    fields as readonly string[],
    loc.defaultLocale,
  ) as R;
}
