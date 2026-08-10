/**
 * WebhookService — приём push-событий статусов СДЭК (docs/08 §8, порт carre
 * WebhookService.php + CdekController::actionWebhook).
 *
 * КЛЮЧЕВОЕ — идемпотентность (docs/08 §8.3): событие пишется в cdek_status_log
 * через insertStatusLog (ON CONFLICT DO NOTHING по UNIQUE (cdek_uuid,
 * status_code, status_date_time)); при дубликате (inserted=false) обработка не
 * повторяется. Повторная доставка вебхука всегда безопасна.
 *
 * Чистые тестируемые функции (без сети/БД, всегда зелёные):
 *   • verifyWebhookIp — IP-whitelist (точные IP + CIDR), trust-proxy, mock-bypass;
 *   • parseEvent      — нормализация payload СДЭК в CdekEvent.
 * БД-зависимый handleWebhookEvent — интеграционно (skipIf) либо с моком
 * repository.insertStatusLog в юнит-тесте.
 *
 * ПОДПИСКА НА ВЕБХУКИ: ensureWebhookSubscription (внизу файла) идемпотентно
 * регистрирует POST /v2/webhooks — без неё в боевом режиме СДЭК не знает наш
 * URL и вебхуки не приходят ВОВСЕ (статусы обновляются только pull-кроном).
 * Это скрытый блокер: код приёма исправен, интеграция «работает», а событий
 * нет — на живом проде магазина в кабинете СДЭК не оказалось ни одной
 * подписки. Вызывается кнопкой в /admin/cdek (Server Action) и пригодна для
 * периодического вызова из cron (СДЭК автоудаляет подписку при недоступном
 * эндпоинте).
 */

import type { CdekManager } from '../manager';
import { getCdekManager } from '../manager';
import { extractCdekErrors } from '../client';
import { CdekError } from '../errors';
import {
  getShipmentByCdekUuid,
  insertStatusLog,
  markStatusLogProcessed,
  findStatusLogByKey,
} from '../repository';
import { getOrderByNumber } from '@/lib/orders/repository';
import { mapCdekStatus, displayName } from './status-map';
import { advanceDeliveryStatus } from './delivery-status';

// =============================================================================
// verifyWebhookIp — ЧИСТАЯ. IP-whitelist (точные IPv4 + CIDR). docs/08 §8.2.
// =============================================================================

/** IPv4 «1.2.3.4» → 32-битное число; null при невалидном. */
function ipv4ToLong(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** Проверяет вхождение IPv4 в CIDR «1.2.3.0/24» (или точный IP без маски). */
function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const ipLong = ipv4ToLong(ip);
  const netLong = ipv4ToLong(net!);
  if (ipLong === null || netLong === null) return false;
  if (bitsRaw === undefined) {
    return ipLong === netLong; // точный IP
  }
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (netLong & mask);
}

export interface VerifyIpOptions {
  /** Доверять прокси-заголовку (за Caddy). Влияет только на выбор источника IP — вызывающий уже извлёк ip. */
  trustProxy?: boolean;
  /**
   * MOCK-режим (нет боевых ключей CDEK_ACCOUNT/CDEK_SECRET): пустой whitelist
   * разрешён (bypass с warn) — edu/CI-контур. SECURITY: bypass завязан именно на
   * isMock, а НЕ на CDEK_TEST_MODE — иначе боевой test-контур (реальные ключи +
   * CDEK_TEST_MODE) открывал бы write-путь к боевым orders (finding #2).
   */
  isMock?: boolean;
  /**
   * @deprecated НЕ управляет bypass-ом. Оставлен для совместимости контракта;
   * SECURITY-bypass пустого whitelist завязан на isMock (не на testMode).
   */
  testMode?: boolean;
}

/**
 * Проверяет, разрешён ли IP по whitelist (docs/08 §8.2, порт checkIp):
 *   • whitelist непустой → IP должен входить хотя бы в один диапазон (иначе false);
 *   • whitelist пустой → разрешено ТОЛЬКО в mock-режиме (bypass с warn), иначе false.
 * Чистая, детерминированная. trustProxy здесь не меняет результат (источник IP
 * выбирает route-слой) — принимается для совместимости контракта.
 *
 * SECURITY: пустой whitelist в боевом режиме (isMock=false) → ВСЕГДА false, даже
 * при CDEK_TEST_MODE. Открыть запись в боевые orders «test-контуром» нельзя.
 */
export function verifyWebhookIp(
  ip: string,
  whitelist: readonly string[],
  opts: VerifyIpOptions = {},
): boolean {
  if (!whitelist || whitelist.length === 0) {
    if (opts.isMock) {
      console.warn('[cdek] webhook IP-whitelist пуст — bypass разрешён только в mock-режиме (нет боевых ключей).');
      return true;
    }
    return false;
  }
  return whitelist.some((cidr) => ipInCidr(ip, cidr));
}

// =============================================================================
// parseEvent — ЧИСТАЯ. Нормализация payload СДЭК → CdekEvent. docs/08 §8.3.
// =============================================================================

/** Нормализованное событие webhook (порт parseEvent). */
export interface CdekEvent {
  type: string | null;
  /** UUID отправления в СДЭК. */
  cdekUuid: string | null;
  /** Наш номер заказа (attributes.number) — приоритетный ключ поиска. */
  orderNumber: string | null;
  /** Трек-номер СДЭК (attributes.cdek_number). */
  cdekNumber: string | null;
  statusCode: string | null;
  statusName: string | null;
  statusDateTime: Date | null;
  cityCode: number | null;
  cityName: string | null;
  raw: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function int(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function dt(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Нормализует входной payload вебхука СДЭК в CdekEvent (чистая). Толерантна к
 * форме: читает top-level type/uuid + attributes.* (number/cdek_number/code/
 * status_code/status_date_time/city_*). Невалидный объект → событие с null-полями
 * (вызывающий отфильтрует по отсутствию cdekUuid/statusCode).
 */
export function parseEvent(payload: unknown): CdekEvent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const attrs = (p.attributes && typeof p.attributes === 'object'
    ? p.attributes
    : {}) as Record<string, unknown>;

  const code = str(attrs.code) ?? str(attrs.status_code);
  return {
    type: str(p.type),
    cdekUuid: str(p.uuid) ?? str(attrs.cdek_uuid) ?? str(attrs.order_uuid),
    orderNumber: str(attrs.number),
    cdekNumber: str(attrs.cdek_number),
    statusCode: code,
    statusName: str(attrs.status_name) ?? (code ? displayName(code) : null),
    statusDateTime: dt(attrs.status_date_time),
    cityCode: int(attrs.city_code),
    cityName: str(attrs.city_name),
    raw: p,
  };
}

// =============================================================================
// handleWebhookEvent — обработка с идемпотентностью (БД).
// =============================================================================

export interface HandleResult {
  processed: boolean;
  duplicate: boolean;
}

export class WebhookService {
  constructor(private readonly manager: CdekManager = getCdekManager()) {}

  /**
   * Обрабатывает событие вебхука с идемпотентностью (docs/08 §8.3):
   *   1) parseEvent → нормализация;
   *   2) поиск заказа по orderNumber → по cdek_uuid (через shipment); не найден → no-op;
   *   3) insertStatusLog (ON CONFLICT DO NOTHING); дубликат → {duplicate:true} без обработки;
   *   4) маппинг статуса + переход delivery_status (canTransition) — недопустимый молча пропускается;
   *   5) markStatusLogProcessed.
   * Всегда безопасно при повторной доставке (никаких двойных переходов/эффектов).
   *
   * @param ip IP источника вебхука (из route-слоя) — сохраняется в
   *   cdek_status_log.ip для аудита (миграция 0017, finding #3).
   */
  async handleWebhookEvent(payload: unknown, ip?: string): Promise<HandleResult> {
    const event = parseEvent(payload);

    if (!event.cdekUuid || !event.statusCode) {
      return { processed: false, duplicate: false };
    }

    // 1) Поиск заказа (orderNumber приоритетнее, затем по shipment.cdek_uuid).
    let orderId: string | null = null;
    if (event.orderNumber) {
      const o = await getOrderByNumber(event.orderNumber);
      orderId = o?.order.id ?? null;
    }
    if (!orderId) {
      const sh = await getShipmentByCdekUuid(event.cdekUuid);
      orderId = sh?.orderId ?? null;
    }
    if (!orderId) {
      console.warn(
        `[cdek] webhook: заказ не найден (number=${event.orderNumber}, uuid=${event.cdekUuid}).`,
      );
      return { processed: false, duplicate: false };
    }

    // 2) Идемпотентная запись в лог.
    const logResult = await insertStatusLog({
      orderId,
      cdekUuid: event.cdekUuid,
      statusCode: event.statusCode,
      statusName: event.statusName,
      statusDateTime: event.statusDateTime,
      cityCode: event.cityCode,
      cityName: event.cityName,
      isMock: this.manager.isMock,
      rawPayload: event.raw,
      ip: ip ?? null,
    });

    // Идемпотентность опирается на `processed`, а не на сам факт вставки (БАГ #10,
    // аудит волны 15): insertStatusLog коммитит дедуп-запись ДО применения перехода;
    // если переход/пометка упали (транзиент), ретрай webhook должен ПЕРЕОБРАБОТАТЬ,
    // а не молча скипнуть по ON CONFLICT (иначе переход статуса теряется навсегда).
    let entry = logResult.entry;
    if (!logResult.inserted) {
      const existing = await findStatusLogByKey(
        event.cdekUuid,
        event.statusCode,
        event.statusDateTime,
      );
      if (!existing || existing.processed) {
        // Настоящий дубликат (уже обработан) — НЕ повторяем эффекты.
        return { processed: false, duplicate: true };
      }
      // Прошлая доставка вставила запись, но упала до markProcessed → переобрабатываем.
      entry = existing;
    }

    // 3) Маппинг + докрутка delivery_status ПО ШАГАМ до актуального (C4-2): если СДЭК
    // прислал статус с прыжком (потерян in_transit), advanceDeliveryStatus пройдёт цепь
    // по шагам, а не дропнет переход молча. Повторный/уже-достигнутый — идемпотентный no-op.
    const next = mapCdekStatus(event.statusCode);
    if (next) {
      await advanceDeliveryStatus(orderId, next, `cdek-webhook:${event.statusCode}`);
    }

    // 4) Пометить лог обработанным (точка коммита идемпотентности).
    if (entry) {
      await markStatusLogProcessed(entry.id);
    }

    return { processed: true, duplicate: false };
  }
}

// =============================================================================
// ensureWebhookSubscription — регистрация подписки на вебхуки в СДЭК.
//
// Боевой гэп №2 аудита 2026-07-09: POST /v2/webhooks нигде не вызывался — в
// боевом режиме СДЭК просто не знал наш URL, и вебхуки не приходили вообще
// (статусы обновлялись только pull-кроном). Механизм (webhooks.md):
//   • GET  /v2/webhooks            — список активных подписок [{uuid,type,url}];
//   • POST /v2/webhooks {type,url} — добавить (дубль типа создаёт ЕЩЁ одну!);
//   • DELETE /v2/webhooks/{uuid}   — удалить;
//   • лимит — 2 подписки у клиента; подписка автоудаляется, если наш эндпоинт
//     не отвечает 200 (24ч) или таймаутит (12 попыток/75 мин) → функция
//     пригодна для периодического вызова из cron (мониторинг живости).
// =============================================================================

/** Путь вебхука СДЭК в нашем приложении (route: app/api/cdek/webhook). */
export const CDEK_WEBHOOK_PATH = '/api/cdek/webhook';

/**
 * Типы событий, на которые платформа держит подписку.
 *
 * Только ORDER_STATUS: его обрабатывает handleWebhookEvent. PRINT_FORM
 * СОЗНАТЕЛЬНО не подписываем — печать работает синхронным опросом
 * (PrintService, print.md «Асинхронная модель»), обработчика PRINT_FORM в
 * route нет, а лимит СДЭК — 2 подписки на клиента: тратить слот впустую нельзя.
 */
export const CDEK_WEBHOOK_TYPES: readonly string[] = ['ORDER_STATUS'];

/** Одна подписка из GET /v2/webhooks. */
export interface WebhookSubscriptionInfo {
  uuid: string;
  type: string;
  url: string;
}

/** Строка отчёта по одной подписке (url — с замаскированным секретом). */
export interface WebhookSubscriptionReportRow {
  type: string;
  uuid: string | null;
  url: string;
}

/** Итог ensureWebhookSubscription (безопасен для UI/аудита: секрет маскирован). */
export interface WebhookSubscriptionReport {
  /** true — mock-режим (нет боевых ключей): подписка не требуется, no-op. */
  mock: boolean;
  /** Целевой URL подписки с маскированным ?key= (null, если не вычислен). */
  targetUrl: string | null;
  created: WebhookSubscriptionReportRow[];
  kept: WebhookSubscriptionReportRow[];
  /** Пересозданные НАШИ подписки с устаревшим доменом (удалённые старые). */
  deleted: WebhookSubscriptionReportRow[];
  errors: string[];
}

/** Маскирует секрет в query (?key=…) для отчёта/аудита/UI. */
export function maskWebhookUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]*/g, '$1***');
}

/**
 * Сравнивает URL подписки с целевым с нормализацией (СДЭК может вернуть URL в
 * канонизированном виде — иначе каждая проверка пересоздавала бы подписку):
 * совпадение origin + pathname (без хвостового «/») + значения query `key`.
 */
function urlsEquivalent(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (p: string): string => p.replace(/\/+$/, '');
    return (
      ua.origin === ub.origin &&
      norm(ua.pathname) === norm(ub.pathname) &&
      (ua.searchParams.get('key') ?? '') === (ub.searchParams.get('key') ?? '')
    );
  } catch {
    return a === b;
  }
}

/** Наш ли это URL: path совпадает с CDEK_WEBHOOK_PATH (домен может устареть). */
function isOurWebhookUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === CDEK_WEBHOOK_PATH;
  } catch {
    return false;
  }
}

/** Толерантный разбор GET /v2/webhooks (массив на верхнем уровне по докам). */
function parseSubscriptionList(raw: unknown): WebhookSubscriptionInfo[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).entity)
      ? ((raw as Record<string, unknown>).entity as unknown[])
      : [];
  const out: WebhookSubscriptionInfo[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const uuid = str(rec.uuid);
    const type = str(rec.type);
    const url = str(rec.url);
    if (uuid && type && url) out.push({ uuid, type, url });
  }
  return out;
}

/** Человекочитаемая строка ошибки СДЭК для отчёта (код + детали errors[]). */
function describeCdekFailure(prefix: string, err: unknown): string {
  if (err instanceof CdekError) {
    const details = err.cdekErrors.map((e) => `${e.code}: ${e.message}`).join('; ');
    return `${prefix}: ${err.code}${details ? ` (${details})` : ''} — ${err.message}`;
  }
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Опции ensureWebhookSubscription (инъекции для тестов/cron). */
export interface EnsureWebhookSubscriptionOptions {
  /** Менеджер СДЭК (по умолчанию процессный синглтон). */
  manager?: CdekManager;
  /**
   * Источник публичного базового URL приложения. По умолчанию —
   * shop_settings.seo.site_url (единственный существующий конфиг публичного
   * домена: витрина и админка — одно Next-приложение, /api/cdek/webhook живёт
   * на том же домене). Динамический импорт настроек — чтобы юнит-окружение без
   * БД не тянуло слой настроек.
   */
  resolveBaseUrl?: () => Promise<string | null>;
}

/** Дефолтный источник базового URL: shop_settings.seo.site_url. */
async function defaultResolveBaseUrl(): Promise<string | null> {
  try {
    const { getEffectiveSettings } = await import('@/lib/config/settings');
    const eff = await getEffectiveSettings();
    return eff.seo.site_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Идемпотентно приводит подписки СДЭК к целевому состоянию (вызывается кнопкой
 * «Проверить подписку на вебхуки» в /admin/cdek и пригодна для cron):
 *   1) mock-режим → no-op с mock:true (подписываться некуда и незачем);
 *   2) целевой URL = base (site_url) + CDEK_WEBHOOK_PATH + ?key=CDEK_WEBHOOK_SECRET
 *      (если секрет задан — совместимо с проверкой ?key= в route). Если не
 *      настроены НИ секрет, НИ IP-whitelist — подписку НЕ создаём (роут отвечает
 *      401, СДЭК удалит подписку через 24ч) → понятная ошибка в отчёте;
 *   3) GET /v2/webhooks: для каждого типа из CDEK_WEBHOOK_TYPES
 *      • есть подписка с нашим URL (нормализованное сравнение) → kept;
 *      • подписка с НАШИМ path, но устаревшим доменом/секретом → DELETE + POST;
 *      • ЧУЖИЕ url (другой path) НЕ трогаем — мультитенантная осторожность;
 *      • нет ни одной → POST /v2/webhooks {type, url};
 *   4) ответы POST разбираются на requests[].errors (state INVALID → errors[]).
 *
 * СЕКРЕТ НЕ УТЕКАЕТ: во всех строках отчёта url маскируется (key=***) — отчёт
 * безопасен для UI и audit_log.
 */
export async function ensureWebhookSubscription(
  opts: EnsureWebhookSubscriptionOptions = {},
): Promise<WebhookSubscriptionReport> {
  const manager = opts.manager ?? getCdekManager();
  const report: WebhookSubscriptionReport = {
    mock: manager.isMock,
    targetUrl: null,
    created: [],
    kept: [],
    deleted: [],
    errors: [],
  };

  // Все строки ошибок отчёта проходят маскировку секрета вебхука (key=***):
  // сообщения СДЭК могут отражать присланный url с ?key=<секрет> (аудит 2026-07-09
  // #4), а report.errors пишется в audit_log и рендерится оператору в админке.
  const pushError = (msg: string): number => report.errors.push(maskWebhookUrl(msg));

  // (1) mock-режим — no-op (нет боевых ключей → нет и кабинета СДЭК).
  if (manager.isMock) return report;

  // (2) Публичный базовый URL приложения.
  const resolveBaseUrl = opts.resolveBaseUrl ?? defaultResolveBaseUrl;
  const base = await resolveBaseUrl();
  if (!base) {
    pushError(
      'Не задан публичный домен приложения: заполните «Домен сайта (site_url)» в ' +
        'Настройки → SEO — без него невозможно вычислить URL вебхука для СДЭК.',
    );
    return report;
  }

  const cfg = manager.config;
  if (!cfg.webhookSecret && cfg.webhookAllowedIps.length === 0) {
    pushError(
      'Вебхук не защищён: задайте CDEK_WEBHOOK_SECRET (или CDEK_WEBHOOK_IPS + ' +
        'CDEK_WEBHOOK_TRUST_PROXY). Роут отвечает 401 на незащищённые запросы, и ' +
        'СДЭК автоматически удалит такую подписку через 24 часа — подписка не создана.',
    );
    return report;
  }

  let target: URL;
  try {
    target = new URL(CDEK_WEBHOOK_PATH, base);
  } catch {
    pushError(`Некорректный site_url («${base}») — не удалось построить URL вебхука.`);
    return report;
  }
  if (cfg.webhookSecret) target.searchParams.set('key', cfg.webhookSecret);
  const targetUrl = target.toString();
  report.targetUrl = maskWebhookUrl(targetUrl);

  // (3) Текущие подписки.
  let existing: WebhookSubscriptionInfo[];
  try {
    const raw = await manager.client.request<unknown>('GET', '/v2/webhooks');
    existing = parseSubscriptionList(raw);
  } catch (err) {
    pushError(describeCdekFailure('Не удалось получить список подписок (GET /v2/webhooks)', err));
    return report;
  }

  for (const type of CDEK_WEBHOOK_TYPES) {
    const ofType = existing.filter((s) => s.type === type);
    const exact = ofType.find((s) => urlsEquivalent(s.url, targetUrl));
    if (exact) {
      report.kept.push({ type, uuid: exact.uuid, url: maskWebhookUrl(exact.url) });
      continue;
    }

    // Наши устаревшие (path совпал, домен/секрет — нет) → пересоздаём. Чужие
    // подписки (другой path) не трогаем: их держат другие системы клиента.
    const stale = ofType.filter((s) => isOurWebhookUrl(s.url));
    for (const s of stale) {
      try {
        await manager.client.request('DELETE', `/v2/webhooks/${s.uuid}`);
        report.deleted.push({ type, uuid: s.uuid, url: maskWebhookUrl(s.url) });
      } catch (err) {
        pushError(describeCdekFailure(`Не удалось удалить устаревшую подписку ${s.uuid}`, err));
      }
    }

    // POST сознательно БЕЗ idempotent:true: авто-повтор мог бы создать дубль
    // подписки (СДЭК создаёт ещё одну при том же типе), а лимит — 2 на клиента.
    try {
      const res = await manager.client.request<Record<string, unknown>>('POST', '/v2/webhooks', {
        json: { type, url: targetUrl },
      });
      const apiErrors = extractCdekErrors(res);
      if (apiErrors.length > 0) {
        pushError(
          `Подписка ${type} отклонена СДЭК: ` +
            apiErrors.map((e) => `${e.code}: ${e.message}`).join('; '),
        );
        continue;
      }
      const entity = (res?.entity ?? null) as Record<string, unknown> | null;
      const uuid = entity && typeof entity.uuid === 'string' ? entity.uuid : null;
      report.created.push({ type, uuid, url: maskWebhookUrl(targetUrl) });
    } catch (err) {
      pushError(describeCdekFailure(`Не удалось создать подписку ${type} (POST /v2/webhooks)`, err));
    }
  }

  return report;
}
