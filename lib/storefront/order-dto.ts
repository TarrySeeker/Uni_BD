/**
 * Публичные DTO заказов Storefront API + проверка доступа к заказу
 * (docs/07 §4.2, ADR-008/010). Отдельный файл (НЕ dto.ts каталога) — зона 3.D.
 *
 * ПРИНЦИП (как dto.ts каталога): витрине отдаём ТОЛЬКО публично-безопасные поля.
 * НЕ раскрываем наружу: `ip` оформления, `idempotencyKey`, внутренний `id`
 * заказа/позиции, `customerId`, `paymentRef`, `cdekUuid`. Покупателю в ЛК/трекинге
 * нужны: номер, статусы (заказ/оплата/доставка), позиции-снимок, суммы, трек.
 *
 * ANTI-ENUMERATION (§4.2): `GET /orders/:number` защищён — отдаём заказ только
 * при предъявлении токена заказа (HMAC от id, см. orderAccessToken) ИЛИ верного
 * email покупателя. Иначе нельзя перебрать чужие номера.
 *
 * Чистые функции — тестируемы без БД/Next.
 */

import { createHmac } from 'node:crypto';

import type { Order, OrderItem, PromoCode, PromoApplyScope, PromoKind } from '@/lib/orders/types';
import type { QuoteResult } from '@/lib/orders/pricing';
import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
} from '@/lib/orders/labels';

// ---------------------------------------------------------------------------
// Токен доступа к заказу (анти-перебор номеров).
// ---------------------------------------------------------------------------

/** Demo/dev-фолбэк секрета токена заказа (НЕ используется в production — fail-closed). */
const ORDER_TOKEN_DEV_FALLBACK = 'admik-storefront-order-token';

/**
 * Секрет для HMAC токена заказа. Приоритет (m10):
 *   1) ORDER_TOKEN_SECRET — выделенный секрет (развязан от пароля админки);
 *   2) APP_PASSWORD / OWNER_PASSWORD — легаси-фолбэк (непрерывность токенов магазинов,
 *      которые уже на нём; есть в бою);
 *   3) в PRODUCTION без какого-либо секрета — БРОСАЕМ (fail-closed): иначе токен
 *      считался бы по ЗАШИТОЙ В РЕПО константе → любой мог бы предсказать токен и
 *      получить доступ к чужому заказу по номеру;
 *   4) вне production (dev/test/demo без секретов) — стабильный фолбэк (mock-режим).
 * Токен детерминированный → пересчитывается на GET без хранения в БД.
 */
function orderTokenSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const dedicated = env.ORDER_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const legacy = (env.APP_PASSWORD || env.OWNER_PASSWORD)?.trim();
  if (legacy) return legacy;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'ORDER_TOKEN_SECRET (или APP_PASSWORD) не задан — токены доступа к заказу ' +
        'небезопасны в production (предсказуемы по зашитой константе).',
    );
  }
  return ORDER_TOKEN_DEV_FALLBACK;
}

/**
 * Fail-closed ПРЕДпроверка: секрет токена заказа настроен (C7-1). Вызывать в начале
 * POST /orders — ДО createOrder. Иначе мисконфигурация (в production не задан ни
 * ORDER_TOKEN_SECRET, ни APP_PASSWORD, ни OWNER_PASSWORD) приводила бы к 500 ПОСЛЕ
 * коммита заказа (orderTokenSecret бросает в toOrderCreatedDto уже после createOrder):
 * заказ-сирота в БД, клиент без accessToken и без 201. Проверка тем же резолвером и тем
 * же env, что и реальная генерация токена → если прошла, toOrderCreatedDto не бросит.
 */
export function assertOrderTokenConfigured(
  env: Record<string, string | undefined> = process.env,
): void {
  orderTokenSecret(env);
}

/**
 * Непредсказуемый токен доступа к заказу из его id (HMAC-SHA256, base64url, 32
 * символа). Выдаётся при создании заказа (POST /orders) и сверяется на
 * GET /orders/:number. Без секрета его нельзя угадать по номеру заказа.
 */
export function orderAccessToken(
  orderId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return createHmac('sha256', orderTokenSecret(env))
    .update(orderId)
    .digest('base64url')
    .slice(0, 32);
}

/** Сравнение строк постоянного времени-ish (длина + посимвольно). Экспортируется
 * для переиспользования (напр. сверка ?key= webhook СДЭК) — единый constant-time
 * хелпер вместо дублирования. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Аргументы подтверждения доступа к заказу (из query/заголовков GET). */
export interface OrderAccessProof {
  /** ?token= — токен заказа (orderAccessToken). */
  token?: string | null;
  /** ?email= — email покупателя для сверки. */
  email?: string | null;
}

/**
 * Проверяет право читать заказ: верный токен ИЛИ совпадение email покупателя
 * (регистронезависимо, как citext). Пустое подтверждение → отказ (анти-перебор).
 */
export function verifyOrderAccess(
  order: Order,
  proof: OrderAccessProof,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const token = proof.token?.trim();
  if (token && safeEqual(token, orderAccessToken(order.id, env))) {
    return true;
  }
  const email = proof.email?.trim().toLowerCase();
  if (email && email === order.customerEmail.trim().toLowerCase()) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Публичные DTO.
// ---------------------------------------------------------------------------

/** Позиция заказа в публичном виде (снимок; без внутренних id). */
export interface OrderItemDto {
  name: string;
  sku: string;
  attributes: Record<string, unknown>;
  unitPrice: string;
  compareAtPrice: string | null;
  qty: number;
  lineTotal: string;
  /** Подарочная позиция (промокод gift_*): unitPrice/lineTotal = 0. */
  isGift: boolean;
}

/** Публичный статус заказа для трекинга/ЛК (GET /orders/:number). */
export interface OrderPublicDto {
  number: string;
  status: Order['status'];
  paymentStatus: Order['paymentStatus'];
  deliveryStatus: Order['deliveryStatus'];
  /** Готовые РУССКИЕ подписи статусов (G-15) — единый источник lib/orders/labels;
   *  витрина показывает их вместо своей карты (устранено расхождение admin↔витрина). */
  statusLabel: string;
  paymentStatusLabel: string;
  deliveryStatusLabel: string;

  itemsTotal: string;
  discountTotal: string;
  deliveryTotal: string;
  grandTotal: string;
  currency: string;

  promoCode: string | null;
  paymentMethod: Order['paymentMethod'];

  delivery: {
    type: Order['deliveryType'];
    city: string | null;
    /** Трек-номер СДЭК (если присвоен, Этап 4). */
    track: string | null;
  };

  items: OrderItemDto[];

  createdAt: string;
}

/** Ответ создания заказа (POST /orders): минимум + токен доступа к трекингу. */
export interface OrderCreatedDto {
  number: string;
  status: Order['status'];
  paymentStatus: Order['paymentStatus'];
  grandTotal: string;
  currency: string;
  /** Токен для GET /orders/:number (ЛК витрины), не хранится в БД. */
  accessToken: string;
}

// ---------------------------------------------------------------------------
// Мапперы.
// ---------------------------------------------------------------------------

/** Позиция заказа → публичный DTO (снимок; внутренние id скрыты). */
export function toOrderItemDto(item: OrderItem): OrderItemDto {
  return {
    name: item.nameSnapshot,
    sku: item.skuSnapshot,
    attributes: item.attributesSnapshot,
    unitPrice: item.unitPrice,
    compareAtPrice: item.compareAtSnapshot,
    qty: item.quantity,
    lineTotal: item.lineTotal,
    isGift: item.isGift,
  };
}

/**
 * Заказ + позиции → публичный DTO трекинга. НЕ включает ip/idempotencyKey/
 * внутренние id/customerId/paymentRef/cdekUuid (утечка запрещена, §4.2).
 */
export function toOrderPublicDto(order: Order, items: OrderItem[]): OrderPublicDto {
  return {
    number: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    deliveryStatus: order.deliveryStatus,
    statusLabel: orderStatusLabel(order.status),
    paymentStatusLabel: paymentStatusLabel(order.paymentStatus),
    deliveryStatusLabel: deliveryStatusLabel(order.deliveryStatus),

    itemsTotal: order.itemsTotal,
    discountTotal: order.discountTotal,
    deliveryTotal: order.deliveryTotal,
    grandTotal: order.grandTotal,
    currency: order.currency,

    promoCode: order.promoCode,
    paymentMethod: order.paymentMethod,

    delivery: {
      type: order.deliveryType,
      city: order.deliveryCity,
      track: order.cdekTrack,
    },

    items: items.map(toOrderItemDto),

    createdAt: order.createdAt.toISOString(),
  };
}

/** Заказ → DTO ответа создания (+ токен доступа к трекингу). */
export function toOrderCreatedDto(
  order: Order,
  env: Record<string, string | undefined> = process.env,
): OrderCreatedDto {
  return {
    number: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    grandTotal: order.grandTotal,
    currency: order.currency,
    accessToken: orderAccessToken(order.id, env),
  };
}

// ---------------------------------------------------------------------------
// Promotions — публичный список активных акций (GET /promotions, бейджи).
// ---------------------------------------------------------------------------

/**
 * Публичная акция для бейджей витрины («3 по 2», «−10% на бренд X»). СКРЫВАЕТ
 * usageLimit/usedCount/perCustomerLimit/comment/id (как dto.ts каталога). Отдаёт
 * только маркетинговые поля + резолвнутые slug категорий/брендов таргетов.
 */
export interface PublicPromotionDto {
  /** Безопасная маркетинговая метка (НЕ секретный код промокода; m6). */
  publicLabel: string;
  kind: PromoKind;
  applyScope: PromoApplyScope;
  /** bogo «купи N / плати M» (null для прочих типов). */
  bogoBuyQty: number | null;
  bogoPayQty: number | null;
  /** Slug-и категорий/брендов таргетов (для глубоких ссылок витрины). */
  targetCategorySlugs: string[];
  targetBrandSlugs: string[];
  activeFrom: string | null;
  activeTo: string | null;
}

/** Число из NUMERIC-строки без хвостовых нулей ('10.00'→'10', '10.50'→'10.5'). */
function trimNumStr(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

/**
 * БЕЗОПАСНАЯ публичная метка акции (m6). РАНЬШЕ publicLabel = promo.code — публичный
 * GET /promotions раскрывал СЕКРЕТНУЮ строку промокода (любой активный код можно было
 * вычитать и применить). Метка строится из маркетинговых, не-секретных полей
 * (kind/value/bogo) — самого кода НЕ содержит. Те же поля уже отдаются в DTO (kind,
 * bogoBuyQty/PayQty), так что новой утечки нет, а код больше не покидает сервер.
 */
export function publicPromoLabel(promo: PromoCode): string {
  switch (promo.kind) {
    case 'percent':
      return `−${trimNumStr(promo.value)}%`;
    case 'fixed':
      return `−${trimNumStr(promo.value)} ₽`;
    case 'free_delivery':
      return 'Бесплатная доставка';
    case 'bogo':
      return promo.bogoBuyQty && promo.bogoPayQty
        ? `${promo.bogoBuyQty} по цене ${promo.bogoPayQty}`
        : 'Акция';
    default:
      return 'Акция';
  }
}

/** Промокод + резолвнутые slug таргетов → публичный DTO акции (без приватных полей). */
export function toPublicPromotionDto(input: {
  promo: PromoCode;
  targetCategorySlugs?: string[];
  targetBrandSlugs?: string[];
}): PublicPromotionDto {
  const { promo } = input;
  return {
    publicLabel: publicPromoLabel(promo),
    kind: promo.kind,
    applyScope: promo.applyScope,
    bogoBuyQty: promo.bogoBuyQty,
    bogoPayQty: promo.bogoPayQty,
    targetCategorySlugs: input.targetCategorySlugs ?? [],
    targetBrandSlugs: input.targetBrandSlugs ?? [],
    activeFrom: promo.startsAt ? promo.startsAt.toISOString() : null,
    activeTo: promo.endsAt ? promo.endsAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Quote — публичный DTO расчёта корзины (POST /cart/quote). Ничего не создаёт.
// ---------------------------------------------------------------------------

/** Позиция расчёта корзины (актуальная цена + доступность). */
export interface QuoteLineDto {
  name: string;
  sku: string;
  unitPrice: string;
  compareAtPrice: string | null;
  qty: number;
  lineTotal: string;
  /** Подарочная позиция (промокод gift_*): unitPrice/lineTotal = 0. */
  isGift: boolean;
}

/** Публичный DTO расчёта корзины (anti-tamper: суммы серверные). */
export interface QuoteDto {
  itemsTotal: string;
  discountTotal: string;
  deliveryTotal: string;
  grandTotal: string;
  currency: string;
  lines: QuoteLineDto[];
  promo: {
    applied: boolean;
    code: string | null;
    discount: string;
    /** Машиночитаемая причина отказа промокода (если не применён). */
    reason: string | null;
  };
  delivery: {
    free: boolean;
    freeThresholdMet: boolean;
    cost: string;
    /**
     * Удалось ли рассчитать стоимость доставки. false — расчёт СДЭК был нужен,
     * но упал: `cost` НЕ доверять, показать «уточняется» и не давать оформить
     * (createOrder всё равно вернёт ошибку — anti-undercharge). По умолчанию true.
     */
    available: boolean;
  };
  /** Все позиции в наличии и валидны — можно оформлять. */
  fulfillable: boolean;
  /** Проблемные позиции (индекс в items + код проблемы). */
  issues: Array<{ index: number; code: string }>;
}

/**
 * Результат quoteCart → публичный DTO. promoReason — причина отказа промокода
 * (если был передан и невалиден), issues — проблемные позиции.
 */
export function toQuoteDto(input: {
  quote: QuoteResult;
  currency: string;
  fulfillable: boolean;
  promoReason?: string | null;
  issues: Array<{ index: number; code: string }>;
  /** Удалось ли рассчитать доставку (см. QuoteDto.delivery.available). По умолч. true. */
  deliveryResolved?: boolean;
}): QuoteDto {
  const { quote } = input;
  return {
    itemsTotal: quote.itemsTotal,
    discountTotal: quote.discount,
    deliveryTotal: quote.deliveryCost,
    grandTotal: quote.grandTotal,
    currency: input.currency,
    lines: quote.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      unitPrice: l.unitPrice,
      compareAtPrice: l.compareAt,
      qty: l.qty,
      lineTotal: l.lineTotal,
      isGift: l.isGift ?? false,
    })),
    promo: {
      applied: quote.promo.applied,
      code: quote.promo.code,
      discount: quote.promo.discount,
      reason: input.promoReason ?? null,
    },
    delivery: {
      free: quote.delivery.free,
      freeThresholdMet: quote.delivery.freeThresholdMet,
      cost: quote.delivery.cost,
      available: input.deliveryResolved ?? true,
    },
    fulfillable: input.fulfillable,
    issues: input.issues,
  };
}
