/**
 * Ядро i18n витрины carre — три языка как на старом carrerusse.com:
 *   - русский (ru) — ОСНОВНОЙ, живёт на КОРНЕ без префикса (`/`, `/catalog`, …);
 *   - английский (en) — под префиксом `/en/...`;
 *   - французский (fr) — под префиксом `/fr/...`.
 *
 * РОУТИНГ (App Router): все страницы физически лежат под `app/[lang]/`, а
 * `middleware.ts` переписывает голые пути (`/catalog`) во внутренний `/ru/catalog`
 * (URL в адресной строке остаётся голым — ru без видимого префикса). Пути `/en/*`
 * и `/fr/*` проходят как есть. Отсюда: сегмент `lang` в params ВСЕГДА один из
 * трёх кодов, а видимый URL для ru — без префикса.
 *
 * Локаль пробрасывается в КАЖДЫЙ вызов Storefront API (`?locale=`) — сервер
 * локализует title/SEO/контент секций и переводы каталога/CMS (ru+en/fr jsonb).
 * Контент без перевода API сам фолбэчит на ru (resolve запрошенный→ru→null).
 */

/** Поддерживаемые локали витрины. Порядок = порядок в переключателе (Ru/Eng/Fra). */
export const LOCALES = ['ru', 'en', 'fr'] as const;

/** Тип локали витрины. */
export type Locale = (typeof LOCALES)[number];

/** Локаль по умолчанию (основной язык магазина). Живёт на корне без префикса. */
export const DEFAULT_LOCALE: Locale = 'ru';

/** `lang` из тега <html> для каждой локали (BCP-47). */
export const HTML_LANG: Record<Locale, string> = {
  ru: 'ru',
  en: 'en',
  fr: 'fr',
};

/** Короткие подписи локалей для переключателя (совпадают со слепком carre). */
export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Рус',
  en: 'Eng',
  fr: 'Fra',
};

/** Проверка: строка — валидная локаль витрины. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * enabled-набор локалей витрины (связка с настройкой языков магазина, волна 5).
 *
 * Вход — settings.i18n.locales из Storefront API (набор языков, включённых
 * владельцем в админке). Результат = пересечение этого набора с whitelist
 * поддерживаемых кодов LOCALES, с сохранением порядка и без дублей: выключенный в
 * админке язык сюда НЕ попадает (витрина перестаёт его показывать), а незнакомый
 * код (напр. 4-й язык) молча отбрасывается — добавление языка вне охвата волны,
 * union Locale не ослабляется.
 *
 * Fail-open: пустой/отсутствующий вход (настройки недоступны — API упал, старый
 * ответ без поля i18n) ИЛИ вход без единого валидного кода → весь whitelist. Так
 * переключатель языков не пустеет при сбое настроек, а выключение работает только
 * когда админка реально прислала набор.
 */
export function enabledLocalesFrom(
  locales: readonly string[] | null | undefined,
): Locale[] {
  const seen = new Set<Locale>();
  const out: Locale[] = [];
  for (const l of locales ?? []) {
    if (isLocale(l) && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out.length > 0 ? out : [...LOCALES];
}

/** Нормализация произвольного значения в локаль (неизвестное → дефолт ru). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Префикс локали для URL. Для ru — пусто (корень), для en/fr — `/en`|`/fr`.
 * Основа построения всех внутренних ссылок витрины.
 */
export function localePrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}`;
}

/**
 * Построение локализованной внутренней ссылки. Абсолютный путь `path` (начинается
 * с «/») склеивается с префиксом текущей локали:
 *   localizedHref('/catalog', 'ru') → '/catalog'
 *   localizedHref('/catalog', 'en') → '/en/catalog'
 *   localizedHref('/',        'fr') → '/fr'
 * Внешние ссылки (http/https, mailto:, tel:) и пустые — возвращаются без изменений.
 */
export function localizedHref(path: string, locale: Locale): string {
  if (!path) return path;
  // Внешние/специальные схемы и protocol-relative — не трогаем.
  if (/^(https?:)?\/\//i.test(path) || /^[a-z]+:/i.test(path)) return path;
  if (!path.startsWith('/')) return path; // относительные — как есть (редкость)

  const prefix = localePrefix(locale);
  if (!prefix) return path; // ru — корень
  // '/' → '/en' (без хвостового слэша), '/catalog' → '/en/catalog'.
  return path === '/' ? prefix : `${prefix}${path}`;
}

/**
 * Разбор входящего pathname на { locale, rest } — где rest уже БЕЗ префикса
 * локали (для построения ссылок «тот же путь на другом языке» в переключателе).
 *   '/en/catalog' → { locale:'en', rest:'/catalog' }
 *   '/fr'         → { locale:'fr', rest:'/' }
 *   '/catalog'    → { locale:'ru', rest:'/catalog' }
 *   '/'           → { locale:'ru', rest:'/' }
 */
export function stripLocale(pathname: string): { locale: Locale; rest: string } {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (isLocale(first) && first !== DEFAULT_LOCALE) {
    const rest = '/' + segments.slice(1).join('/');
    return { locale: first, rest: rest === '/' ? '/' : rest.replace(/\/$/, '') || '/' };
  }
  return { locale: DEFAULT_LOCALE, rest: pathname || '/' };
}

/**
 * Перестроение текущего пути под другую локаль (для переключателя языка). Берёт
 * «голый» путь без префикса и навешивает префикс целевой локали.
 *   switchLocalePath('/en/catalog', 'fr') → '/fr/catalog'
 *   switchLocalePath('/en/catalog', 'ru') → '/catalog'
 */
export function switchLocalePath(currentPathname: string, target: Locale): string {
  const { rest } = stripLocale(currentPathname);
  return localizedHref(rest, target);
}

/**
 * hreflang-альтернативы для generateMetadata: для каждой ВКЛЮЧЁННОЙ локали — URL
 * того же (голого) пути с её префиксом; canonical — текущая локаль. `path` —
 * бесхитростный путь без локали (`/`, `/catalog`, `/product/x`).
 *   alternatesFor('/catalog', 'en') → {
 *     canonical:'/en/catalog',
 *     languages:{ ru:'/catalog', en:'/en/catalog', fr:'/fr/catalog' }
 *   }
 * `locales` — enabled-набор (по умолчанию весь whitelist LOCALES); выключенный в
 * админке язык, переданный сюда усечённым набором, НЕ попадёт в hreflang. canonical
 * считается напрямую по `current` (корректен, даже если current вне набора — напр.
 * запрос выключенного языка до редиректа layout). Значения — относительные пути;
 * Next.js разрешит их относительно metadataBase.
 */
export function alternatesFor(
  path: string,
  current: Locale,
  locales: readonly Locale[] = LOCALES,
): { canonical: string; languages: Record<string, string> } {
  const languages: Record<string, string> = {};
  for (const l of locales) {
    languages[l] = localizedHref(path, l) || '/';
  }
  return { canonical: localizedHref(path, current) || '/', languages };
}
