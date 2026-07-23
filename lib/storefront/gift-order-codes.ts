/**
 * Публичная выдача кодов подарочных сертификатов, выпущенных ПО заказу
 * (ТЗ владельца п.11 — «промокод высвечивается после оформления заказа»).
 *
 * 🔴 Код сертификата — деньги на предъявителя. Поэтому он живёт в ОТДЕЛЬНОМ
 * ответе отдельного эндпоинта, а не в OrderPublicDto: общий DTO заказа отдаётся
 * и по email-пути трекинга, и кешируется витриной, и логируется при отладке —
 * ни одно из этих свойств для денег недопустимо.
 *
 * Здесь — чистая логика (состояние блока + минимальный DTO кода) и ведро
 * rate-limit этого эндпоинта. Ни Next, ни БД.
 */

import { normalizeClientIp } from '@/lib/server/request-ip';
import {
  createRateLimiter,
  MemoryRateBackend,
  RedisRateBackend,
  type RateCheckResult,
  type RateLimiter,
} from '@/lib/auth/rate-limit';
import { getEnv } from '@/lib/config/env';
import { isGiftItemForAutoIssue, type CertificateSourceItem } from '@/lib/gift-certificates/origin';
import type { GiftCertificate, GiftSettings } from '@/lib/gift-certificates/types';
import type { Order } from '@/lib/orders/types';

// ---------------------------------------------------------------------------
// DTO.
// ---------------------------------------------------------------------------

/**
 * Состояние блока «ваш подарочный сертификат» на странице успеха:
 *  - none    — в заказе нет позиций-сертификатов (или заказ отменён/возвращён):
 *              блок не рендерится вовсе;
 *  - pending — сертификат куплен, но кода ещё нет (оплата подтверждается либо
 *              выпуск догоняет): витрина опрашивает эндпоинт;
 *  - ready   — коды выпущены и заказ оплачен: показываем.
 */
export type GiftCodesState = 'none' | 'pending' | 'ready';

/** Минимум, нужный покупателю. Ни id, ни сторон сделки, ни заказа. */
export interface GiftOrderCodeDto {
  code: string;
  /** Номинал (что уплачено за позицию). */
  amount: string;
  /** Остаток на предъявителя (номинал − потрачено). */
  remaining: string;
  currency: string;
  /** ISO-дата окончания действия; null — бессрочно. */
  validUntil: string | null;
}

/** Ответ GET /orders/:number/gift-codes. */
export interface GiftCodesPayload {
  state: GiftCodesState;
  codes: GiftOrderCodeDto[];
}

// ---------------------------------------------------------------------------
// Чистая логика.
// ---------------------------------------------------------------------------

/** Статусы заказа, при которых код не выдаётся (деньги уже вернули покупателю). */
const DEAD_ORDER_STATUSES: readonly Order['status'][] = ['cancelled', 'refunded'];

/**
 * Заказ пригоден к показу кода: ОПЛАЧЕН и не отменён/возвращён. Та же калитка,
 * что у автовыпуска (auto-issue.orderGateReason) — расхождение означало бы
 * «показали код, которого нет» или наоборот.
 */
export function isOrderEligibleForGiftCodes(order: {
  paymentStatus: Order['paymentStatus'];
  status: Order['status'];
}): boolean {
  return order.paymentStatus === 'paid' && !DEAD_ORDER_STATUSES.includes(order.status);
}

/**
 * Статусы сертификата, которые покупателю показывать нельзя. 'disabled' —
 * это в т.ч. код, ПОГАШЕННЫЙ при возврате заказа (revokeIssuedGiftsTx): показать
 * его — обещать деньги, которых больше нет.
 */
function isVisibleToBuyer(cert: GiftCertificate): boolean {
  return cert.status !== 'disabled';
}

/** Сертификат → публичный минимум (без id/сторон сделки/связей с заказом). */
export function toGiftOrderCodeDto(cert: GiftCertificate): GiftOrderCodeDto {
  return {
    code: cert.code,
    amount: cert.initialAmount,
    remaining: cert.remaining,
    currency: cert.currency,
    validUntil: cert.validUntil ? cert.validUntil.toISOString() : null,
  };
}

/**
 * Состояние блока + коды.
 *
 * Порядок проверок важен: сначала калитка заказа (не оплачен / отменён → кода
 * нет НИКОГДА, даже если строка сертификата в БД уже есть), и только потом —
 * что показывать.
 *
 * 'pending' обещаем лишь когда код действительно ожидается: есть позиция с
 * маркером сертификата И автовыпуск включён. Иначе покупатель ждал бы кода,
 * который никто не выпустит.
 */
export function buildGiftCodesPayload(input: {
  order: { paymentStatus: Order['paymentStatus']; status: Order['status'] };
  items: CertificateSourceItem[];
  certificates: GiftCertificate[];
  settings: GiftSettings;
}): GiftCodesPayload {
  const { order, items, certificates, settings } = input;
  const dead = DEAD_ORDER_STATUSES.includes(order.status);
  const eligible = isOrderEligibleForGiftCodes(order);

  const codes = eligible ? certificates.filter(isVisibleToBuyer).map(toGiftOrderCodeDto) : [];
  if (codes.length > 0) return { state: 'ready', codes };

  const expects = !dead && items.some((item) => isGiftItemForAutoIssue(item, settings));
  return { state: expects ? 'pending' : 'none', codes: [] };
}

// ---------------------------------------------------------------------------
// Rate-limit эндпоинта (СОБСТВЕННОЕ ведро).
// ---------------------------------------------------------------------------

/**
 * Порог перебора для эндпоинта кодов. Общий storefront-лимит (600/мин на IP)
 * рассчитан на SSR-витрину и для денег слишком щедр. Здесь запросы делает только
 * страница успеха (опрос раз в 5 c, максимум ~24 попытки), поэтому 40/мин с
 * запасом хватает живому покупателю и режет автоматический перебор.
 */
export const GIFT_CODES_RATE_LIMIT = {
  maxAttempts: 40,
  windowSec: 60,
} as const;

/** Ключ ведра — по валидированному IP, префикс отдельный от общего storefront-ведра. */
export function giftCodesRateKey(ip: string | undefined): string {
  return `gift-codes:ip:${ip ?? 'unknown'}`;
}

/** Ключ ведра из заголовков запроса (X-Forwarded-For / X-Real-IP). */
export function giftCodesRateKeyFromRequest(headers: Headers): string {
  return giftCodesRateKey(
    normalizeClientIp(headers.get('x-forwarded-for'), headers.get('x-real-ip')),
  );
}

let limiter: Promise<RateLimiter> | undefined;

function getLimiter(): Promise<RateLimiter> {
  if (limiter) return limiter;
  limiter = (async (): Promise<RateLimiter> => {
    const opts = {
      maxAttempts: GIFT_CODES_RATE_LIMIT.maxAttempts,
      windowSec: GIFT_CODES_RATE_LIMIT.windowSec,
    };
    const { REDIS_URL } = getEnv();
    if (REDIS_URL) {
      const { default: IORedis } = await import('ioredis');
      const redis = new IORedis(REDIS_URL, { lazyConnect: true });
      return createRateLimiter({ backend: new RedisRateBackend(redis), ...opts });
    }
    return createRateLimiter({ backend: new MemoryRateBackend(), ...opts });
  })();
  return limiter;
}

export async function checkGiftCodesRate(key: string): Promise<RateCheckResult> {
  return (await getLimiter()).checkLoginRate(key);
}

export async function registerGiftCodesHit(key: string): Promise<void> {
  return (await getLimiter()).registerLoginFailure(key);
}
