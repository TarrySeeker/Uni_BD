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
 * База АБСОЛЮТНЫХ URL витрины — публичный адрес магазина из его же настроек
 * (`seo.siteUrl`, админка → Настройки → SEO). Тот же источник, что у sitemap/robots
 * и у return-url платежей, поэтому домен нигде не хардкодится (мультитенантность:
 * платформа обслуживает разные магазины на разных доменах).
 *
 * 🔴 АУДИТ №34. Прежде hreflang эмитился ОТНОСИТЕЛЬНЫМИ путями, а `metadataBase`
 * витрина не задавала нигде — Next подставлял `http://localhost:3000`, и связку
 * альтернатив поисковики игнорировали. Абсолютную базу берём отсюда.
 *
 * Устойчивость к version skew и «протухшим» данным БД (тот же класс защиты, что в
 * lib/seo.ts): нет настроек / нет секции / не строка / пусто → null (остаёмся на
 * относительных путях — прежнее поведение, не хуже). Схема НЕ http(s) отвергается
 * (anti-XSS/anti-open-redirect: значение приезжает в атрибут href альтернатив).
 * Хвостовые слэши срезаются, иначе склейка даст `https://shop//en/catalog`.
 */
export function absoluteUrlBase(
  settings: { seo?: { siteUrl?: string | null } } | null | undefined,
): string | null {
  const raw: unknown = settings?.seo?.siteUrl;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^/]/i.test(trimmed)) return null;
  const base = trimmed.replace(/\/+$/, '');
  return base === '' ? null : base;
}

/**
 * hreflang-альтернативы для generateMetadata: для каждой ВКЛЮЧЁННОЙ локали — URL
 * того же (голого) пути с её префиксом; canonical — текущая локаль. `path` —
 * бесхитростный путь без локали (`/`, `/catalog`, `/product/x`).
 *   alternatesFor('/catalog', 'en', LOCALES, 'https://shop.example') → {
 *     canonical:'https://shop.example/en/catalog',
 *     languages:{ ru:'https://shop.example/catalog', … }
 *   }
 * `locales` — enabled-набор (по умолчанию весь whitelist LOCALES); выключенный в
 * админке язык, переданный сюда усечённым набором, НЕ попадёт в hreflang. canonical
 * считается напрямую по `current` (корректен, даже если current вне набора — напр.
 * запрос выключенного языка до редиректа layout).
 *
 * `base` (аудит №34) — абсолютная база из настроек магазина (absoluteUrlBase). С
 * ней значения становятся АБСОЛЮТНЫМИ URL, как того требует спецификация hreflang;
 * без неё (настройка не заполнена) отдаём прежние относительные пути — деградация
 * до старого поведения, а не поломка.
 */
export function alternatesFor(
  path: string,
  current: Locale,
  locales: readonly Locale[] = LOCALES,
  base: string | null = null,
): { canonical: string; languages: Record<string, string> } {
  const abs = (href: string): string => (base ? `${base}${href}` : href);
  const languages: Record<string, string> = {};
  for (const l of locales) {
    languages[l] = abs(localizedHref(path, l) || '/');
  }
  return { canonical: abs(localizedHref(path, current) || '/'), languages };
}

// =============================================================================
// Маршрутизация локале-подобных префиксов (аудит №33 major + №12 minor).
// =============================================================================

/**
 * Решение маршрутизации по входящему pathname — чистая функция, чтобы edge-
 * middleware оставался тонким, а поведение проверялось юнитами без Next.
 *
 * 🔴 АУДИТ №33. Прежде middleware распознавал префикс локали РЕГУЛЯРКОЙ
 * `/^[a-z]{2}(-[a-z]{2})?$/`, то есть ЛЮБОЙ похожий на локаль сегмент
 * (`/de/catalog`) пропускался как есть. Сегмент `[lang]` получал `de`, `toLocale`
 * фолбэчил его в `ru`, а `stripLocale` (ему нужен ИМЕННО `isLocale`) считал
 * `/de/catalog` голым ru-путём — переключатель языка строил несуществующий
 * `/en/de/catalog`. Корневого `app/not-found.tsx` не было, поэтому покупатель видел
 * ГОЛУЮ англоязычную 404 Next без шапки, футера и ссылок. Тот же голый 404
 * отдавался на `/ru/<путь>`: regex исключал только сам `ru`, и путь уезжал в
 * rewrite `/ru/ru/...`.
 *
 * 🔴 АУДИТ №12. Та же первопричина: CMS-страница со slug из двух букв (`/qa`)
 * матчилась той же регуляркой и уходила в маршрут `[lang]` (главная на языке «qa»)
 * вместо `[lang]/[slug]` — страница становилась недостижимой.
 *
 * ПОЧЕМУ WHITELIST ЗДЕСЬ ЛЕГИТИМЕН. Прежний комментарий утверждал, что набор
 * языков нельзя знать на edge, так как он живёт в БД. Это смешение двух разных
 * наборов: в БД живёт набор ВКЛЮЧЁННЫХ владельцем языков (его по-прежнему читает
 * только layout), а `LOCALES` — набор языков, которые витрина физически УМЕЕТ
 * (её словари и переводы, компилятивная константа этого же приложения). Второй
 * известен на этапе сборки, БД для него не нужна, и включение языка вне `LOCALES`
 * всё равно требует правки кода витрины (словарь). Поэтому edge вправе его знать:
 * задержки/точки отказа/утечки конфига не появляется.
 *
 * Исходы:
 *   - `pass`     — реальный не-дефолтный префикс (`/en`, `/fr/...`): пропустить;
 *   - `redirect` — явный префикс дефолта (`/ru/...`): 308 на канонический голый
 *                  путь (дефолт живёт на корне; `/ru/*` — SEO-дубль, которого нет);
 *   - `rewrite`  — всё остальное (`/`, `/catalog`, `/qa`, `/de/catalog`): внутрь
 *                  сегмента дефолтной локали. `/qa` тем самым доходит до
 *                  `[lang]/[slug]` (CMS-страница жива), а `/de/catalog` даёт
 *                  ЛОКАЛИЗОВАННУЮ 404 внутри layout — с шапкой, футером и ссылками.
 */
export type RouteDecision =
  | { kind: 'pass' }
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'redirect'; pathname: string; permanent: true };

export function routeDecision(pathname: string): RouteDecision {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];

  // Реальная не-дефолтная локаль витрины — проходит как есть (сегмент [lang] уже
  // заполнен). Включённость языка проверит layout: она из БД, edge её не знает.
  if (isLocale(first) && first !== DEFAULT_LOCALE) {
    return { kind: 'pass' };
  }

  // Явный префикс дефолтной локали — канонизируем редиректом на голый путь.
  // ПОСТОЯННЫЙ 308 (не 307): `/ru/*` не является адресом витрины ни при какой
  // настройке — дефолт живёт на корне по устройству схемы URL, а не по значению
  // из БД. 308 (а не 301) сохраняет метод и тело запроса.
  if (first === DEFAULT_LOCALE) {
    const rest = segments.slice(1).join('/');
    return { kind: 'redirect', pathname: rest ? `/${rest}` : '/', permanent: true };
  }

  // Всё остальное — внутрь сегмента дефолтной локали. Неизвестный локале-подобный
  // префикс сюда и попадает: `[lang]` получает валидный `ru`, поэтому дальше
  // отработают layout и локализованный not-found, а не голая 404 Next.
  return {
    kind: 'rewrite',
    pathname: pathname === '/' ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${pathname}`,
  };
}
