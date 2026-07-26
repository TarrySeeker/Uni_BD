/**
 * АДРЕС ВОЗВРАТА покупателя с платёжного шлюза — общий для всех адаптеров
 * (paykeeper/tbank/alfabank).
 *
 * ЗАЧЕМ. Платёжные шлюзы возвращают покупателя на адрес, заданный в ЛК мерчанта.
 * Такой адрес СТАТИЧЕН: он не несёт ни номера заказа, ни токена доступа. Страница
 * успеха витрины без `number` печатает «Не удалось определить заказ», а блок кодов
 * подарочных сертификатов требует ещё и `token` — то есть купленный сертификат
 * (деньги на предъявителя) покупатель не увидел бы вовсе: модуля e-mail в платформе
 * нет. Поэтому пер-заказный адрес возврата обязан уезжать в шлюз при создании счёта.
 *
 * 🔴 БЕЗОПАСНОСТЬ — ГЛАВНОЕ ПРАВИЛО: ORIGIN ТОЛЬКО ИЗ ДОВЕРЕННОГО ИСТОЧНИКА.
 * Адрес возврата уезжает в платёжный шлюз и превращается в редирект покупателя С
 * ЛЕГИТИМНОЙ ПЛАТЁЖНОЙ ФОРМЫ. Если origin можно подменить из запроса — это open
 * redirect + фишинг + утечка `number`/`token` заказа в query чужого сайта.
 *
 * ⚠️ НЕ ПУТАТЬ С АДРЕСОМ DEMO-СТРАНИЦЫ ОПЛАТЫ (`baseOrigin` адаптеров). Тот ведёт на
 * домен ЭТОГО приложения (страницы app/mock/<провайдер>/pay), а не на витрину, и
 * берётся из другого источника — lib/payments/app-origin.ts. Подстановка сюда origin
 * витрины ломала demo-оплату (витрина и приложение — разные хосты), а подстановка
 * туда origin из запроса безопасна: та ссылка возвращается самому вызывающему.
 *
 * ДОВЕРЕННЫЕ источники origin (по приоритету):
 *   1) `shop_settings.seo.site_url` — публичный адрес витрины, который владелец
 *      задал в админке (Настройки → SEO). Уже используется для canonical/sitemap/
 *      robots. Мультитенантно, никакого хардкода домена.
 *   2) `STOREFRONT_ALLOWED_ORIGINS` — список доменов витрин магазина из env
 *      инстанса. Тоже задан владельцем, лежит на сервере, покупателем не влияем.
 *      Берётся ПЕРВЫЙ валидный (канонический домен инстанса).
 *
 * НЕдоверенные источники (НЕ используются как origin НИКОГДА):
 *   • `returnUrl` из ТЕЛА запроса — его пишет клиент;
 *   • `X-Forwarded-Host` / `X-Forwarded-Proto` — их ставит прокси, но Caddy
 *     ДОПИСЫВАЕТ к уже присутствующим значениям, а не затирает их, и сам заголовок
 *     производен от клиентского `Host`. На уровне приложения отличить «поставил наш
 *     Caddy» от «прислал злоумышленник» нельзя → доверять нельзя;
 *   • origin из `req.url` — за реверс-прокси это внутренний `http://app:3000`,
 *     то есть либо бесполезен, либо производен от того же клиентского `Host`.
 *
 * Из адреса, присланного витриной, берётся ТОЛЬКО ПУТЬ (он несёт локаль:
 * `/en/cart/success`) и только после валидации (см. safeReturnPath): `//host`,
 * обратный слэш и управляющие символы браузером/`new URL` трактуются как смена
 * хоста. Финальный инвариант проверяется ещё раз после сборки URL.
 *
 * Нет доверенного origin → адрес НЕ собирается и шлюзу НЕ передаётся (поведение
 * как до появления этого модуля: покупатель вернётся на статический адрес из ЛК),
 * плюс громкий warn владельцу — чтобы он задал настройку.
 *
 * `number`/`token` подставляет СЕРВЕР; значения из тела запроса игнорируются.
 * Токен доступа неизбежно едет в шлюз (иначе страница успеха бесполезна), но в
 * ЛОГИ он не попадает: для диагностических сообщений есть maskOrderReturnUrl.
 *
 * Все функции, кроме resolveOrderReturnUrl, — ЧИСТЫЕ и НЕ бросают: мисконфигурация
 * магазина не должна ронять инициацию платежа.
 */

import { parseAllowedOrigins } from '@/lib/storefront/env';

/** Путь страницы успеха витрины по умолчанию (шаблон витрины платформы). */
export const DEFAULT_ORDER_RETURN_PATH = '/cart/success';

/** Параметр адреса возврата с номером заказа. */
const PARAM_NUMBER = 'number';
/** Параметр адреса возврата с токеном доступа к заказу. */
const PARAM_TOKEN = 'token';

/** Разумный потолок длины пути возврата (защита от мусора в шлюзе). */
const MAX_RETURN_PATH_LENGTH = 512;

/**
 * Символы, которых в безопасном пути быть не может:
 *   • `\` — `new URL('/\\evil.test', origin)` даёт `https://evil.test` (для
 *     «специальных» схем обратный слэш эквивалентен `/`);
 *   • управляющие символы и пробелы — таб/перевод строки ВЫРЕЗАЮТСЯ парсером URL,
 *     превращая `/<TAB>/evil.test` в `//evil.test`, то есть в чужой хост.
 * Дефис/точка/юникод в пути допустимы — локали и слаги витрины их используют.
 */
const UNSAFE_PATH_CHARS = /[\\\s]|[\u0000-\u001f\u007f]/;

/**
 * Правдоподобный хост: DNS-имя/IPv4 (`[a-z0-9.-]`, IDN уже в punycode после разбора)
 * либо IPv6 в скобках. Нужен, потому что `new URL('https://${SHOP_DOMAIN}')`
 * РАЗБИРАЕТСЯ успешно: без этой проверки нераскрытый плейсхолдер из .env стал бы
 * «доверенным» origin, и шлюз увозил бы покупателя на несуществующий домен вместо
 * честного «адрес возврата не настроен» + warn.
 */
const PLAUSIBLE_HOST = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/;

/**
 * Нормализует произвольную строку в origin (`https://host[:port]`), отбрасывая путь
 * и хвостовой слэш. Не-http(s), строка без схемы, неправдоподобный хост и мусор →
 * null. НЕ бросает.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!PLAUSIBLE_HOST.test(parsed.hostname)) return null;
  return parsed.origin;
}

/** Путь безопасен: одиночный ведущий `/`, без `\`, управляющих символов и пробелов. */
function isSafePath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  // `//host/x` — protocol-relative: увёл бы на чужой хост.
  if (path.startsWith('//')) return false;
  if (path.length > MAX_RETURN_PATH_LENGTH) return false;
  return !UNSAFE_PATH_CHARS.test(path);
}

/**
 * Безопасный путь страницы возврата. Из абсолютного адреса берётся ТОЛЬКО pathname
 * (сохраняет локаль витрины), относительный путь принимается после валидации.
 * Всё, что может увести с доверенного origin, → путь по умолчанию. НЕ бросает.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_ORDER_RETURN_PATH,
): string {
  const value = raw?.trim();
  if (!value) return fallback;

  let candidate: string;
  if (value.startsWith('/')) {
    candidate = value;
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fallback;
      candidate = parsed.pathname;
    } catch {
      return fallback;
    }
  }
  candidate = candidate.split('?')[0]!.split('#')[0]!;
  return isSafePath(candidate) ? candidate : fallback;
}

/** Доверенные источники публичного origin витрины (оба задаёт ВЛАДЕЛЕЦ). */
export interface TrustedOriginSources {
  /** `shop_settings.seo.site_url` (админка → Настройки → SEO). ПРИОРИТЕТ. */
  siteUrl?: string | null;
  /** `STOREFRONT_ALLOWED_ORIGINS` — домены витрин инстанса из env. */
  allowedOrigins?: readonly string[] | null;
}

/**
 * Единственная точка выбора origin. Значения из запроса сюда не попадают ПО
 * КОНСТРУКЦИИ: параметров для них нет.
 */
export function resolveTrustedOrigin(sources: TrustedOriginSources): string | null {
  const fromSettings = normalizeOrigin(sources.siteUrl);
  if (fromSettings) return fromSettings;
  for (const candidate of sources.allowedOrigins ?? []) {
    const normalized = normalizeOrigin(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/** Вход сборки адреса возврата. */
export interface OrderReturnUrlInput extends TrustedOriginSources {
  /** Номер заказа (orders.number) — уедет в параметр `number`. */
  orderNumber: string;
  /**
   * Токен доступа к заказу (orderAccessToken). Пусто → параметра `token` не будет:
   * страница успеха покажет номер, но не сможет прочитать заказ и коды сертификатов.
   */
  accessToken?: string | null;
  /**
   * Адрес возврата, присланный ВИТРИНОЙ (недоверенный). Берётся ТОЛЬКО безопасный
   * путь — он несёт локаль. Origin отсюда НЕ берётся ни при каких условиях.
   */
  requestedUrl?: string | null;
  /** Путь страницы успеха по умолчанию (если витрина ничего не прислала). */
  defaultPath?: string;
}

/**
 * Собирает абсолютный адрес возврата с параметрами заказа. Возвращает null, если
 * нет ДОВЕРЕННОГО origin (настройка магазина/env владельца) или номер пуст — тогда
 * шлюзу адрес не передаётся и он вернёт покупателя по своим настройкам. ЧИСТАЯ,
 * НЕ бросает.
 */
export function buildOrderReturnUrl(input: OrderReturnUrlInput): string | null {
  const number = input.orderNumber?.trim();
  if (!number) return null;

  const origin = resolveTrustedOrigin(input);
  if (!origin) return null;

  const fallbackPath = input.defaultPath ?? DEFAULT_ORDER_RETURN_PATH;
  const path = safeReturnPath(input.requestedUrl, fallbackPath);

  const build = (candidatePath: string): URL | null => {
    try {
      const url = new URL(candidatePath, origin);
      // Пояс и подтяжки: даже если валидация пути что-то пропустила, адрес обязан
      // остаться на доверенном origin — иначе он не покидает сервер.
      return url.origin === origin ? url : null;
    } catch {
      return null;
    }
  };

  const url = build(path) ?? build(DEFAULT_ORDER_RETURN_PATH);
  if (!url) return null;

  // Параметры заказа — ТОЛЬКО серверные (всё, что пришло в пути, отбрасываем).
  url.search = '';
  url.searchParams.set(PARAM_NUMBER, number);
  const token = input.accessToken?.trim();
  if (token) url.searchParams.set(PARAM_TOKEN, token);
  return url.toString();
}

/**
 * Маскирует токен доступа в адресе возврата для БЕЗОПАСНОГО логирования (номер
 * заказа остаётся — он и так в логах платежа). НЕ бросает: мусор возвращается как есть.
 */
export function maskOrderReturnUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has(PARAM_TOKEN)) parsed.searchParams.set(PARAM_TOKEN, '***');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Читает `shop_settings.seo.site_url`. Настройки могут быть недоступны (нет БД на
 * этапе сборки/в юнит-тестах) — это НЕ повод ронять оплату: ошибка глотается.
 * getEffectiveSettings мемоизирован на процесс, поэтому вызывать не жалко.
 */
async function readSiteUrlSetting(): Promise<string | null> {
  try {
    const { getEffectiveSettings } = await import('@/lib/config/settings');
    const settings = await getEffectiveSettings();
    return settings.seo.site_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Резолвит адрес возврата, читая ДОВЕРЕННЫЙ origin витрины из настроек магазина, а
 * при их отсутствии — из STOREFRONT_ALLOWED_ORIGINS инстанса. Возвращает undefined
 * (а не null), чтобы результат можно было расстелить в opts инициации платежа без
 * лишних ветвлений.
 *
 * Настройки могут быть недоступны (нет БД на этапе сборки/в юнит-тестах) — это НЕ
 * повод ронять оплату: ошибка глотается, остаётся env-источник.
 */
export async function resolveOrderReturnUrl(
  input: Omit<OrderReturnUrlInput, keyof TrustedOriginSources>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const siteUrl = await readSiteUrlSetting();
  const allowedOrigins = parseAllowedOrigins(env.STOREFRONT_ALLOWED_ORIGINS);
  const url = buildOrderReturnUrl({ ...input, siteUrl, allowedOrigins });

  if (!url) {
    // Громкая диагностика владельцу: адрес возврата шлюзу НЕ передан, покупатель
    // вернётся на статический адрес из ЛК эквайера — без номера заказа и токена
    // (страница успеха не покажет заказ и код подарочного сертификата).
    console.warn(
      '[payments] Адрес возврата покупателя НЕ передан шлюзу: не задан доверенный ' +
        'публичный адрес витрины. Задайте «Настройки → SEO → Адрес сайта» ' +
        '(shop_settings.seo.site_url) либо STOREFRONT_ALLOWED_ORIGINS в env инстанса. ' +
        'Адрес из запроса покупателя НЕ используется намеренно (open redirect).',
    );
    return undefined;
  }

  if (!normalizeOrigin(siteUrl)) {
    console.warn(
      '[payments] shop_settings.seo.site_url не задан — origin адреса возврата взят из ' +
        'STOREFRONT_ALLOWED_ORIGINS: ' + maskOrderReturnUrl(url),
    );
  }
  return url;
}
