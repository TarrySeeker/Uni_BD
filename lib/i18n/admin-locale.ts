/**
 * Локаль ИНТЕРФЕЙСА админки (next-intl foundation) — чистый, client-safe leaf.
 *
 * WHY отдельно от config.ts: локаль UI админки НЕЗАВИСИМА от shop_settings.i18n
 * (набор языков ВИТРИНЫ). Язык интерфейса — предпочтение конкретного оператора
 * (cookie NEXT_LOCALE / users.ui_locale), а не настройка магазина. Поэтому здесь
 * ЖЁСТКИЙ платформенный набор ['ru','en','fr'] — языки, на которые переведён сам
 * интерфейс панели (messages/*.json), а не языки контента магазина.
 *
 * WHY не импортируем resolveRequestLocale из config.ts: config.ts тянет
 * DB-цепочку (getLocaleConfig → dynamic import репозитория настроек → lib/db/client
 * → драйвер postgres). Этот модуль обязан оставаться client-safe (его будет
 * импортировать клиентский переключатель языка), поэтому импортируем ТОЛЬКО чистый
 * leaf normalizeLocale, а крошечную проверку членства повторяем здесь. Ноль БД,
 * ноль server-only — импорт из браузера безопасен.
 */

import { normalizeLocale } from './locale-token';

/**
 * Платформенный набор языков интерфейса админки. Пополняется вместе с новыми
 * messages/<locale>.json (гард tests/i18n/admin-messages.guard.test.ts следит,
 * чтобы каталоги были полны и синхронны).
 */
export const ADMIN_LOCALE_CONFIG = {
  defaultLocale: 'ru',
  locales: ['ru', 'en', 'fr'],
} as const;

/** Код языка интерфейса админки. */
export type AdminLocale = (typeof ADMIN_LOCALE_CONFIG)['locales'][number];

/** Имя cookie предпочтительного языка интерфейса (совпадает с дефолтом next-intl). */
export const ADMIN_LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Валидирует сырое значение cookie против ADMIN_LOCALE_CONFIG и возвращает
 * гарантированно валидный язык интерфейса. НИКОГДА не доверяет сырому cookie:
 * нормализует, проверяет членство (с фолбэком на первичный subtag 'en-US'→'en'),
 * при любой невалидности откатывается на defaultLocale ('ru'). Не бросает.
 *
 * Алгоритм повторяет resolveRequestLocale (config.ts), но переиспользует только
 * чистый нормализатор — см. WHY в шапке модуля.
 */
export function resolveAdminLocale(raw: string | undefined): AdminLocale {
  if (typeof raw !== 'string') {
    return ADMIN_LOCALE_CONFIG.defaultLocale;
  }

  const norm = normalizeLocale(raw);
  if (!norm) {
    return ADMIN_LOCALE_CONFIG.defaultLocale;
  }

  const locales: readonly string[] = ADMIN_LOCALE_CONFIG.locales;
  if (locales.includes(norm)) {
    return norm as AdminLocale;
  }

  // Фолбэк на первичный subtag ('en-us' → 'en', 'fr-CA' → 'fr').
  const primary = norm.split('-')[0];
  if (primary && locales.includes(primary)) {
    return primary as AdminLocale;
  }

  return ADMIN_LOCALE_CONFIG.defaultLocale;
}
