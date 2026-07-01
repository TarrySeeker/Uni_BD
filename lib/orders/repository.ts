/**
 * Слой доступа к данным модуля orders (docs/07 §3.4, §4.2, §6, ADR-010).
 *
 * Всё через `sql` (tagged templates → параметризация, анти-SQLi). Серверный
 * расчёт корзины и создание заказа — ИСТОЧНИК ИСТИНЫ по ценам/итогу
 * (anti-tamper): цены НИКОГДА не берутся из тела запроса витрины, только из
 * каталога (lib/catalog/repository). Чистая бизнес-логика расчёта — в
 * pricing.ts/promo.ts (юнит-тесты без БД); здесь — загрузка данных, транзакции,
 * атомарный резерв остатков, выдача номера, идемпотентность.
 *
 * Деньги — строки NUMERIC(14,2); арифметика идёт в копейках (money.ts).
 */

import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import { getEnv } from '@/lib/config/env';
import { getEffectiveSettings, isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { getProductById } from '@/lib/catalog/repository';
import { effectiveCompareAt } from '@/lib/catalog/pricing';
import type { Product, ProductDetail, ProductVariant } from '@/lib/catalog/types';
import { MAIN_WAREHOUSE } from '@/lib/catalog/types';

import { fromMinor, normalizeMoney, toMinor } from './money';
import { cartLineIssueMessage } from './cart-messages';
import {
  calculateQuote,
  effectiveUnitPriceMinor,
  emptyScopeTargets,
  giftQuoteLine,
  scopedQty,
  type AppliedPromo,
  type PricedLine,
  type PromoScopeTargets,
  type QuoteResult,
} from './pricing';
import { validatePromo, type PromoValidationResult } from './promo';
import {
  computeDeliveryCost,
  DeliveryCalculationError,
  type DeliveryDestination,
  type DeliveryCostLine,
} from './delivery-cost';
import type { DeliveryType, Order, OrderItem, PaymentMethod, PromoCode } from './types';
import type { CartQuoteInput, CreateOrderInput } from './schemas';

// Сентинель для COALESCE(variant_id, ...) в inventory_unit_uniq (0010).
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// MAIN_WAREHOUSE — из единого источника (lib/catalog/types), общий с витриной (m5).

/** Код нарушения уникального индекса PostgreSQL (как в catalog/actions). */
const PG_UNIQUE_VIOLATION = '23505';

/** true, если ошибка — нарушение уникального индекса (postgres.js прокидывает code). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

// =============================================================================
// Мапперы row→domain.
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}
function asJson(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** promo_codes row → PromoCode (camelCase). */
export function mapPromoCode(row: Record<string, unknown>): PromoCode {
  return {
    id: String(row.id),
    code: String(row.code),
    kind: row.kind as PromoCode['kind'],
    value: String(row.value),
    minOrderTotal: String(row.min_order_total),
    maxDiscount: strOrNull(row.max_discount),
    usageLimit: numOrNull(row.usage_limit),
    perCustomerLimit: numOrNull(row.per_customer_limit),
    usedCount: Number(row.used_count),
    startsAt: row.starts_at ? asDate(row.starts_at) : null,
    endsAt: row.ends_at ? asDate(row.ends_at) : null,
    isActive: Boolean(row.is_active),
    bogoBuyQty: numOrNull(row.bogo_buy_qty),
    bogoPayQty: numOrNull(row.bogo_pay_qty),
    applyScope: (row.apply_scope as PromoCode['applyScope']) ?? 'cart',
    priority: row.priority != null ? Number(row.priority) : 100,
    stackable: Boolean(row.stackable),
    minQty: numOrNull(row.min_qty),
    giftProductId: strOrNull(row.gift_product_id),
    giftVariantId: strOrNull(row.gift_variant_id),
    giftQty: numOrNull(row.gift_qty),
    comment: String(row.comment ?? ''),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** orders row → Order (camelCase). */
export function mapOrder(row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    number: String(row.number),
    status: row.status as Order['status'],
    itemsTotal: String(row.items_total),
    discountTotal: String(row.discount_total),
    deliveryTotal: String(row.delivery_total),
    grandTotal: String(row.grand_total),
    currency: String(row.currency),
    paymentMethod: row.payment_method as Order['paymentMethod'],
    paymentStatus: row.payment_status as Order['paymentStatus'],
    paidAt: row.paid_at ? asDate(row.paid_at) : null,
    paymentRef: strOrNull(row.payment_ref),
    paymentProvider: strOrNull(row.payment_provider),
    deliveryType: row.delivery_type as Order['deliveryType'],
    deliveryStatus: row.delivery_status as Order['deliveryStatus'],
    deliveryCity: strOrNull(row.delivery_city),
    deliveryAddress: strOrNull(row.delivery_address),
    deliveryPvzCode: strOrNull(row.delivery_pvz_code),
    deliveryCost: strOrNull(row.delivery_cost),
    cdekUuid: strOrNull(row.cdek_uuid),
    cdekTrack: strOrNull(row.cdek_track),
    promoCodeId: strOrNull(row.promo_code_id),
    promoCode: strOrNull(row.promo_code),
    customerId: strOrNull(row.customer_id),
    customerName: String(row.customer_name),
    customerEmail: String(row.customer_email),
    customerPhone: String(row.customer_phone),
    comment: String(row.comment ?? ''),
    idempotencyKey: strOrNull(row.idempotency_key),
    source: row.source as Order['source'],
    ip: strOrNull(row.ip),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** order_items row → OrderItem (camelCase). */
export function mapOrderItem(row: Record<string, unknown>): OrderItem {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    productId: strOrNull(row.product_id),
    variantId: strOrNull(row.variant_id),
    nameSnapshot: String(row.name_snapshot),
    skuSnapshot: String(row.sku_snapshot),
    attributesSnapshot: asJson(row.attributes_snapshot),
    unitPrice: String(row.unit_price),
    compareAtSnapshot: strOrNull(row.compare_at_snapshot),
    quantity: Number(row.quantity),
    lineTotal: String(row.line_total),
    isGift: row.is_gift === true,
    weightG: numOrNull(row.weight_g),
    lengthCm: numOrNull(row.length_cm),
    widthCm: numOrNull(row.width_cm),
    heightCm: numOrNull(row.height_cm),
    createdAt: asDate(row.created_at),
  };
}

// =============================================================================
// Промокоды (чтение + счётчики для лимитов, §3.4).
// =============================================================================

/** Промокод по коду (citext — регистронезависимо); null если нет. */
export async function getPromoByCode(code: string): Promise<PromoCode | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, code, kind, value, min_order_total, max_discount, usage_limit,
           per_customer_limit, used_count, starts_at, ends_at, is_active,
           bogo_buy_qty, bogo_pay_qty, apply_scope, priority, stackable, min_qty,
           gift_product_id, gift_variant_id, gift_qty, comment, created_at, updated_at
    FROM promo_codes WHERE code = ${code} LIMIT 1
  `;
  return rows[0] ? mapPromoCode(rows[0]) : null;
}

/** Число применений промокода данным покупателем (email) — для per_customer_limit. */
export async function countCustomerRedemptions(
  promoCodeId: string,
  customerEmail: string,
): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM promo_redemptions
    WHERE promo_code_id = ${promoCodeId} AND customer_email = ${customerEmail}
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Промокод + контекст лимитов в один проход (used_count из строки, redemptions
 * по email если задан). Возвращает null, если кода нет.
 */
export async function getPromoWithCounts(
  code: string,
  customerEmail?: string,
): Promise<{ promo: PromoCode; customerRedemptions: number } | null> {
  const promo = await getPromoByCode(code);
  if (!promo) return null;
  const customerRedemptions = customerEmail
    ? await countCustomerRedemptions(promo.id, customerEmail)
    : 0;
  return { promo, customerRedemptions };
}

/**
 * Промокод + счётчики + резолвнутые scope-таргеты (docs/11 §5.2.3, ADR-014 §4).
 *
 * Догружает promo_targets и собирает множества category/brand/product/variant
 * id, к которым применяется акция (anti-tamper: принадлежность линии scope
 * определит СЕРВЕР через lineInScope — линия несёт собственные categoryIds/
 * brandId/productId/variantId из каталога, мы лишь сверяем с этими таргет-
 * множествами). Категории/бренды НЕ разворачиваются в товарные множества: линия
 * уже знает свои категории/бренд из product_categories / products.brand_id, что
 * эквивалентно и дешевле. Для applyScope='cart' таргеты пусты (вся корзина).
 */
export async function getPromoWithTargets(
  code: string,
  customerEmail?: string,
): Promise<
  | {
      promo: PromoCode;
      customerRedemptions: number;
      scopeTargets: PromoScopeTargets;
    }
  | null
> {
  const found = await getPromoWithCounts(code, customerEmail);
  if (!found) return null;

  const scopeTargets = emptyScopeTargets();
  if (found.promo.applyScope !== 'cart') {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT target_type, category_id, brand_id, product_id, variant_id
      FROM promo_targets
      WHERE promo_code_id = ${found.promo.id}
    `;
    for (const r of rows) {
      if (r.category_id != null) scopeTargets.categoryIds.add(String(r.category_id));
      if (r.brand_id != null) scopeTargets.brandIds.add(String(r.brand_id));
      if (r.product_id != null) scopeTargets.productIds.add(String(r.product_id));
      if (r.variant_id != null) scopeTargets.variantIds.add(String(r.variant_id));
    }
  }

  return { promo: found.promo, customerRedemptions: found.customerRedemptions, scopeTargets };
}

/** Активная акция + резолвнутые slug категорий/брендов таргетов (публичный список). */
export interface ActivePromotion {
  promo: PromoCode;
  targetCategorySlugs: string[];
  targetBrandSlugs: string[];
}

/**
 * Список активных акций для публичного списка-бейджей (docs/11 §5.2.4). Активность
 * по флагу is_active и окну starts_at/ends_at относительно now. Догружает slug-и
 * категорий/брендов таргетов (для глубоких ссылок витрины). Приватные поля
 * (лимиты/used_count/comment/id) скрывает уже DTO-слой (toPublicPromotionDto).
 */
export async function listActivePromotions(now: Date = new Date()): Promise<ActivePromotion[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, code, kind, value, min_order_total, max_discount, usage_limit,
           per_customer_limit, used_count, starts_at, ends_at, is_active,
           bogo_buy_qty, bogo_pay_qty, apply_scope, priority, stackable, min_qty,
           gift_product_id, gift_variant_id, gift_qty, comment, created_at, updated_at
    FROM promo_codes
    WHERE is_active = true
      AND (starts_at IS NULL OR starts_at <= ${now})
      AND (ends_at IS NULL OR ends_at >= ${now})
      AND (usage_limit IS NULL OR used_count < usage_limit)
    ORDER BY priority ASC, created_at DESC
  `;
  const promos = rows.map(mapPromoCode);
  if (promos.length === 0) return [];

  const ids = promos.map((p) => p.id);
  // Slug-и таргет-категорий/брендов одним проходом (JOIN), без N+1.
  const catRows = await sql<{ promo_code_id: string; slug: string }[]>`
    SELECT pt.promo_code_id, c.slug
    FROM promo_targets pt
    JOIN categories c ON c.id = pt.category_id
    WHERE pt.promo_code_id IN ${sql(ids)} AND pt.target_type = 'category'
  `;
  const brandRows = await sql<{ promo_code_id: string; slug: string }[]>`
    SELECT pt.promo_code_id, b.slug
    FROM promo_targets pt
    JOIN brands b ON b.id = pt.brand_id
    WHERE pt.promo_code_id IN ${sql(ids)} AND pt.target_type = 'brand'
  `;

  const catByPromo = new Map<string, string[]>();
  for (const r of catRows) {
    const arr = catByPromo.get(r.promo_code_id) ?? [];
    arr.push(String(r.slug));
    catByPromo.set(r.promo_code_id, arr);
  }
  const brandByPromo = new Map<string, string[]>();
  for (const r of brandRows) {
    const arr = brandByPromo.get(r.promo_code_id) ?? [];
    arr.push(String(r.slug));
    brandByPromo.set(r.promo_code_id, arr);
  }

  return promos.map((promo) => ({
    promo,
    targetCategorySlugs: catByPromo.get(promo.id) ?? [],
    targetBrandSlugs: brandByPromo.get(promo.id) ?? [],
  }));
}

// =============================================================================
// Загрузка цен/остатков позиций из каталога (anti-tamper, ADR-010).
// =============================================================================

/** Резолв-результат одной позиции: либо ценовая строка, либо проблема. */
export interface ResolvedLine extends PricedLine {
  productId: string;
  variantId: string | null;
  attributesSnapshot: Record<string, unknown>;
  /** Доступно к продаже (quantity − reserved) для этого юнита. */
  available: number;
  /** Достаточно ли остатка под запрошенный qty. */
  inStock: boolean;
  /**
   * Снимок веса/габаритов единицы (резолв вариант→товар, 0018/0026). null →
   * дефолт магазина (CDEK_DEFAULT_*) подставит aggregatePackage. Дефолт env
   * здесь НЕ подмешиваем: пишем «как есть в каталоге», чтобы при смене дефолта
   * магазина старые заказы остались на снимке каталога, а пустые брали актуальный.
   */
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
}

export type LineResolution =
  | { ok: true; line: ResolvedLine }
  | { ok: false; reason: 'product_not_found' | 'variant_not_found' | 'inactive' };

/**
 * Резолв веса/габаритов позиции по приоритету вариант→товар (0018, docs/08 §3.2).
 * Чистая, тестируемая без БД. Возвращает «как в каталоге»: NULL означает «нет
 * значения на этих уровнях» → дефолт магазина подставит aggregatePackage СДЭК.
 * Дефолт env здесь НЕ применяется (снимок каталога, не снимок дефолта).
 */
export function resolveLineDims(
  product: Pick<Product, 'weightG' | 'lengthCm' | 'widthCm' | 'heightCm'>,
  variant: Pick<ProductVariant, 'weightG' | 'lengthCm' | 'widthCm' | 'heightCm'> | null,
): { weightG: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null } {
  return {
    weightG: variant?.weightG ?? product.weightG ?? null,
    lengthCm: variant?.lengthCm ?? product.lengthCm ?? null,
    widthCm: variant?.widthCm ?? product.widthCm ?? null,
    heightCm: variant?.heightCm ?? product.heightCm ?? null,
  };
}

/** Доступный остаток юнита (product/variant/main) из ProductDetail.inventory. */
function availableFor(product: ProductDetail, variantId: string | null): number {
  const row = product.inventory.find(
    (i) =>
      i.warehouseCode === MAIN_WAREHOUSE &&
      (variantId === null ? i.variantId === null : i.variantId === variantId),
  );
  if (!row) return 0;
  return Math.max(0, row.quantity - row.reserved);
}

/**
 * Резолвит одну позицию витрины в ценовую строку ИЗ КАТАЛОГА (цена не из
 * запроса). variantId приоритетен; иначе берётся товар без варианта.
 */
export async function resolveCartLine(input: {
  productId?: string;
  variantId?: string;
  qty: number;
}): Promise<LineResolution> {
  // Загружаем товар: либо напрямую по productId, либо найдя владельца варианта.
  let product: ProductDetail | null = null;
  let variant: ProductVariant | null = null;

  if (input.variantId) {
    // Найти товар-владельца варианта.
    const owner = await sql<{ product_id: string }[]>`
      SELECT product_id FROM product_variants WHERE id = ${input.variantId} LIMIT 1
    `;
    if (!owner[0]) return { ok: false, reason: 'variant_not_found' };
    product = await getProductById(owner[0].product_id);
    if (!product) return { ok: false, reason: 'product_not_found' };
    variant = product.variants.find((v) => v.id === input.variantId) ?? null;
    if (!variant) return { ok: false, reason: 'variant_not_found' };
    if (!variant.isActive || product.status !== 'active') {
      return { ok: false, reason: 'inactive' };
    }
  } else if (input.productId) {
    product = await getProductById(input.productId);
    if (!product) return { ok: false, reason: 'product_not_found' };
    if (product.status !== 'active') return { ok: false, reason: 'inactive' };
    // БАГ #11 (аудит цикла 2): товар С активными вариантами нельзя заказать по productId —
    // иначе резервируется ОСИРОТЕВШИЙ product-level остаток (variant_id IS NULL), который
    // витрина намеренно прячет (toProductDetailDto при наличии вариантов считает наличие
    // только по вариантам, #13). Заказ идёт по variantId; требуем выбор варианта.
    if (product.variants.some((v) => v.isActive)) {
      return { ok: false, reason: 'variant_not_found' };
    }
  } else {
    return { ok: false, reason: 'product_not_found' };
  }

  const unitMinor = effectiveUnitPriceMinor({
    basePrice: product.basePrice,
    priceOverride: variant?.priceOverride ?? null,
    priceDelta: variant?.priceDelta ?? null,
  });

  const compareAtNum = effectiveCompareAt(
    variant?.compareAtPrice ?? null,
    product.compareAtPrice,
  );
  const compareAt =
    compareAtNum != null && compareAtNum > Number(fromMinor(unitMinor))
      ? normalizeMoney(compareAtNum)
      : null;

  const variantId = variant?.id ?? null;
  const available = availableFor(product, variantId);
  // Вес/габариты — резолв вариант→товар из каталога (anti-tamper, ADR-010): сервер
  // фиксирует снимок для СДЭК, из тела запроса они НЕ берутся.
  const dims = resolveLineDims(product, variant);

  return {
    ok: true,
    line: {
      productId: product.id,
      variantId,
      name: variant ? `${product.name} — ${variant.name}` : product.name,
      sku: variant?.sku ?? product.sku,
      unitPrice: fromMinor(unitMinor),
      compareAt,
      qty: input.qty,
      // scope-разметка из каталога (anti-tamper, ADR-010): сервер проставляет
      // категории/бренд позиции для определения принадлежности scope акции.
      categoryIds: product.categories.map((c) => c.categoryId),
      brandId: product.brandId,
      attributesSnapshot: variant?.attributesCache ?? product.attributesCache ?? {},
      available,
      inStock: available >= input.qty,
      ...dims,
    },
  };
}

/**
 * Резолвит подарочную позицию промокода (gift_*) в каталожную строку
 * (anti-tamper: товар/цена берутся из каталога). Подарок выдаётся, когда у
 * валидного применённого промокода задан `giftQty >= 1` И хотя бы один из
 * `giftVariantId` / `giftProductId` (вариант приоритетен). Возвращает
 * `ResolvedLine` (с available/inStock) или null — если подарок не задан либо
 * товар-подарок не найден/неактивен. Любой kind промокода может нести подарок.
 */
export async function resolveGiftLine(promo: PromoCode): Promise<ResolvedLine | null> {
  const qty = promo.giftQty ?? 0;
  if (!Number.isInteger(qty) || qty < 1) return null;
  if (!promo.giftVariantId && !promo.giftProductId) return null;
  const res = await resolveCartLine({
    productId: promo.giftProductId ?? undefined,
    variantId: promo.giftVariantId ?? undefined,
    qty,
  });
  return res.ok ? res.line : null;
}

// =============================================================================
// Доставка (расчёт через адаптер lib/orders/delivery-cost, docs/08 §5).
// =============================================================================

/**
 * Стоимость доставки через адаптер (развязка orders↔cdek). При выключенном
 * модуле cdek / самовывозе / отсутствии назначения → '0.00' (поведение Этапа 3
 * сохранено). При включённом cdek + назначении → расчёт СДЭК (mock без сети).
 * Порог бесплатной доставки и промокоды применяются ПОВЕРХ — в calculateQuote.
 */
async function resolveDeliveryCost(args: {
  deliveryType: DeliveryType | undefined;
  // BUG A (CRITICAL, anti-undercharge): сюда ОБЯЗАТЕЛЬНО нести вес/габариты линии,
  // а не только qty. Раньше принимался только { qty } → реальные weightG/lengthCm/…
  // ОТБРАСЫВАЛИСЬ, и aggregatePackage (lib/cdek/.../calculator) подставлял дефолт
  // магазина (CDEK_DEFAULT_WEIGHT ≈ 500 г) для КАЖДОЙ позиции. Итог: и quote, и
  // createOrder считали доставку по дефолтному весу, тогда как order_items.weight_g
  // и реальная СДЭК-накладная (lib/cdek/services/order) билятся по РЕАЛЬНОМУ весу
  // из каталога (resolveLineDims) → магазин недополучал за доставку тяжёлых товаров.
  lines: ReadonlyArray<{
    qty: number;
    weightG?: number | null;
    lengthCm?: number | null;
    widthCm?: number | null;
    heightCm?: number | null;
  }>;
  city?: string;
  cityCode?: number;
  pvzCode?: string;
  /**
   * Мягкий сбой расчёта: true для quote (превью не должно падать → resolved:false),
   * false/undefined для createOrder (сбой нужного расчёта БРОСАЕТ
   * DeliveryCalculationError — anti-undercharge, нулевая доставка недопустима).
   */
  softFail?: boolean;
}): Promise<{ cost: string; resolved: boolean }> {
  const deliveryType: DeliveryType = args.deliveryType ?? 'courier';
  // Назначение: код города (если витрина его знает) + имя города + код ПВЗ.
  // cityName КРИТИЧЕН для курьера (BUG #3): курьерская доставка часто несёт
  // только имя города — без него расчёт деградировал к stub 0.00.
  const destination: DeliveryDestination = {
    cityCode: args.cityCode,
    cityName: args.city,
    pvzCode: args.pvzCode,
  };
  // BUG A: пробрасываем РЕАЛЬНЫЕ вес/габариты из каталога (resolveLineDims) в
  // расчёт доставки — иначе aggregatePackage подставит дефолт магазина и магазин
  // недополучит за доставку (anti-undercharge). null → дефолт магазина (легитимно).
  const lines: DeliveryCostLine[] = args.lines.map((l) => ({
    qty: l.qty,
    weightG: l.weightG ?? null,
    lengthCm: l.lengthCm ?? null,
    widthCm: l.widthCm ?? null,
    heightCm: l.heightCm ?? null,
  }));
  const res = await computeDeliveryCost(
    { deliveryType, lines, destination },
    { softFail: args.softFail },
  );
  return { cost: res.cost, resolved: res.resolved };
}

// =============================================================================
// quoteCart — серверный расчёт корзины (POST /cart/quote). Ничего не создаёт.
// =============================================================================

export interface QuoteCartResult {
  quote: QuoteResult;
  currency: string;
  /** Проблемные позиции (не найдены/неактивны/нет остатка). */
  issues: Array<{
    index: number;
    code: 'product_not_found' | 'variant_not_found' | 'inactive' | 'out_of_stock';
  }>;
  /** Результат валидации промокода (если код передан). */
  promo: PromoValidationResult | null;
  /** Достаточно ли остатка по всем позициям (можно оформлять). */
  fulfillable: boolean;
  /**
   * Удалось ли рассчитать стоимость доставки. false — расчёт СДЭК был нужен,
   * но упал (deliveryTotal в превью НЕ доверять; витрина показывает «уточняется»
   * и не даёт оформить — createOrder всё равно заблокирует, anti-undercharge).
   */
  deliveryResolved: boolean;
}

/**
 * Серверный расчёт корзины: грузит цены/остатки из каталога, проверяет
 * доступность, валидирует промокод, считает итог. НЕ создаёт заказ и НЕ резервирует.
 */
export async function quoteCart(
  input: CartQuoteInput & { customerEmail?: string; now?: Date },
): Promise<QuoteCartResult> {
  const env = getEnv();
  const currency = env.SHOP_CURRENCY;
  // Порог бесплатной доставки — из эффективных настроек (env ⊕ БД), docs/11 §5.4.4.
  // EffectiveSettings хранит порог в КОПЕЙКАХ; calculateQuote ожидает РУБЛИ —
  // конвертируем на границе legacy-расчёта через fromMinor (money-инвариант §7).
  const eff = await getEffectiveSettings();
  const freeThreshold = Number(fromMinor(eff.delivery.freeDeliveryThreshold));

  const issues: QuoteCartResult['issues'] = [];
  // BUG A: тип ResolvedLine (а не PricedLine) — чтобы вес/габариты позиции были
  // ВИДНЫ компилятору и доходили до resolveDeliveryCost. resolveCartLine отдаёт
  // именно ResolvedLine (с weightG/lengthCm/…); calculateQuote принимает
  // PricedLine, а ResolvedLine его расширяет — присваивание корректно.
  const lines: ResolvedLine[] = [];
  // BUG C (консистентность quote↔createOrder): остаток проверяем по СУММАРНОМУ
  // спросу на юнит, а не полинейно. Раньше две линии одного юнита (productId+
  // variantId) по qty каждая проходили per-line inStock (available >= qty), но
  // createOrder резервирует КУМУЛЯТИВНО (reserveUnit вызывается на каждую линию,
  // вторая падает) → quote говорил «можно», а заказ падал out_of_stock. Копим
  // спрос по ключу юнита и сверяем нарастающим итогом — как кумулятивный резерв.
  const demandByUnit = new Map<string, number>();
  const unitKey = (productId: string, variantId: string | null): string =>
    `${productId}:${variantId ?? NIL_UUID}`;

  for (let i = 0; i < input.items.length; i++) {
    const res = await resolveCartLine(input.items[i]!);
    if (!res.ok) {
      issues.push({ index: i, code: res.reason });
      continue;
    }
    const key = unitKey(res.line.productId, res.line.variantId);
    const cumulative = (demandByUnit.get(key) ?? 0) + res.line.qty;
    demandByUnit.set(key, cumulative);
    // out_of_stock — если НАРАСТАЮЩИЙ спрос на юнит превысил доступный остаток
    // (available для всех линий одного юнита одинаков — снимок каталога).
    if (cumulative > res.line.available) {
      issues.push({ index: i, code: 'out_of_stock' });
    }
    lines.push(res.line);
  }

  // Промокод (валидируем по itemsTotal + кол-ву единиц В SCOPE, копейки).
  const itemsMinor = lines.reduce((acc, l) => acc + toMinor(l.unitPrice) * l.qty, 0);
  let promoResult: PromoValidationResult | null = null;
  let appliedPromo: AppliedPromo | null = null;
  let scopeTargets: PromoScopeTargets = emptyScopeTargets();
  let giftPromo: PromoCode | null = null;
  if (input.promoCode) {
    const found = await getPromoWithTargets(input.promoCode, input.customerEmail);
    if (!found) {
      promoResult = {
        valid: false,
        reason: 'inactive',
        message: 'Промокод не найден.',
      };
    } else {
      // minQty сверяем с кол-вом единиц В SCOPE промокода (та же разметка
      // lineInScope, что и в фактическом расчёте скидки) — баг A волны 7. Для
      // scope='cart' это равно itemsQty (всей корзине), поведение не меняется.
      const qtyForMinQty = scopedQty(
        lines,
        found.promo.applyScope ?? 'cart',
        found.scopeTargets,
      );
      promoResult = validatePromo(found.promo, {
        itemsTotal: fromMinor(itemsMinor),
        itemsQty: qtyForMinQty,
        now: input.now,
        usedCount: found.promo.usedCount,
        customerRedemptions: found.customerRedemptions,
      });
      if (promoResult.valid) {
        appliedPromo = promoResult.promo;
        scopeTargets = found.scopeTargets;
        giftPromo = found.promo;
      }
    }
  }

  // quote — превью: softFail, чтобы сбой расчёта СДЭК не ронял корзину (resolved
  // прокидывается наружу; реальную блокировку недоплаты делает createOrder).
  const delivery = await resolveDeliveryCost({
    deliveryType: input.delivery?.type,
    lines,
    city: input.delivery?.city,
    cityCode: input.delivery?.cityCode,
    pvzCode: input.delivery?.pvzCode,
    softFail: true,
  });

  const quote = calculateQuote({
    lines,
    promo: appliedPromo,
    delivery: {
      cost: delivery.cost,
      freeThreshold,
    },
    scopeTargets,
  });

  // Подарок (gift_*): если применённый промокод валиден и несёт подарок, показываем
  // подарочную позицию в превью (price 0). Подарок НЕ входит в itemsTotal/скидку/
  // порог (добавляется ПОСЛЕ расчёта). Best-effort: только если есть остаток.
  if (giftPromo) {
    const gift = await resolveGiftLine(giftPromo);
    if (gift && gift.inStock) {
      quote.lines.push(
        giftQuoteLine({ name: gift.name, sku: gift.sku, value: gift.unitPrice, qty: gift.qty }),
      );
    }
  }

  const fulfillable =
    issues.length === 0 && lines.length === input.items.length && lines.length > 0;

  return {
    quote,
    currency,
    issues,
    promo: promoResult,
    fulfillable,
    deliveryResolved: delivery.resolved,
  };
}

// =============================================================================
// Номер заказа (атомарная выдача, §2.7).
// =============================================================================

/**
 * Выдаёт следующий человекочитаемый номер заказа атомарно (UPSERT + RETURNING).
 * Формат: `[ПРЕФИКС-]ГОД-NNNNNN`. ВЫЗЫВАТЬ ВНУТРИ ТРАНЗАКЦИИ (передать tx).
 */
export async function nextOrderNumber(
  tx: TransactionSql,
  now: Date = new Date(),
): Promise<string> {
  const env = getEnv();
  const year = String(now.getUTCFullYear());
  const rows = await tx<{ last_value: string }[]>`
    INSERT INTO order_number_counters (scope, last_value)
    VALUES (${year}, 1)
    ON CONFLICT (scope)
    DO UPDATE SET last_value = order_number_counters.last_value + 1
    RETURNING last_value
  `;
  const seq = Number(rows[0]!.last_value);
  const padded = String(seq).padStart(6, '0');
  const prefix = env.SHOP_ORDER_PREFIX ? `${env.SHOP_ORDER_PREFIX}-` : '';
  return `${prefix}${year}-${padded}`;
}

// =============================================================================
// Резерв остатков (атомарно, гонко-безопасно, §6).
// =============================================================================

/**
 * Атомарный резерв одного юнита: reserved += qty при наличии доступного остатка.
 * Возвращает true, если зарезервировано (affected = 1); false → нет остатка.
 * ВЫЗЫВАТЬ ВНУТРИ ТРАНЗАКЦИИ.
 */
export async function reserveUnit(
  tx: TransactionSql,
  unit: { productId: string; variantId: string | null; qty: number },
): Promise<boolean> {
  const variantKey = unit.variantId ?? NIL_UUID;
  const rows = await tx<{ id: string }[]>`
    UPDATE inventory
       SET reserved = reserved + ${unit.qty}, updated_at = now()
     WHERE product_id = ${unit.productId}
       AND COALESCE(variant_id, ${NIL_UUID}::uuid) = ${variantKey}::uuid
       AND warehouse_code = ${MAIN_WAREHOUSE}
       AND quantity - reserved >= ${unit.qty}
    RETURNING id
  `;
  return rows.length === 1;
}

/** Возврат резерва (отмена до отгрузки, §6): reserved -= qty. */
export async function releaseReservation(
  tx: TransactionSql,
  unit: { productId: string; variantId: string | null; qty: number },
): Promise<boolean> {
  const variantKey = unit.variantId ?? NIL_UUID;
  const rows = await tx<{ id: string }[]>`
    UPDATE inventory
       SET reserved = reserved - ${unit.qty}, updated_at = now()
     WHERE product_id = ${unit.productId}
       AND COALESCE(variant_id, ${NIL_UUID}::uuid) = ${variantKey}::uuid
       AND warehouse_code = ${MAIN_WAREHOUSE}
       AND reserved >= ${unit.qty}
    RETURNING id
  `;
  return rows.length === 1;
}

/** Списание (отгрузка, §6): quantity -= qty, reserved -= qty. */
export async function commitReservation(
  tx: TransactionSql,
  unit: { productId: string; variantId: string | null; qty: number },
): Promise<boolean> {
  const variantKey = unit.variantId ?? NIL_UUID;
  const rows = await tx<{ id: string }[]>`
    UPDATE inventory
       SET quantity = quantity - ${unit.qty},
           reserved = reserved - ${unit.qty},
           updated_at = now()
     WHERE product_id = ${unit.productId}
       AND COALESCE(variant_id, ${NIL_UUID}::uuid) = ${variantKey}::uuid
       AND warehouse_code = ${MAIN_WAREHOUSE}
       AND reserved >= ${unit.qty}
       AND quantity >= ${unit.qty}
    RETURNING id
  `;
  return rows.length === 1;
}

// =============================================================================
// createOrder — транзакция (ре-валидация, резерв, номер, вставка, промо, история).
// =============================================================================

export interface CreateOrderContext {
  source?: 'storefront' | 'admin';
  ip?: string | null;
  actorUserId?: string | null;
  now?: Date;
}

/**
 * Онлайн-методы оплаты — инициируют платёж Т-Банк (initPayment) и потому требуют
 * включённого модуля payments. Это card/sbp.
 *
 * cdek_pay сюда НЕ входит (регресс-фикс ревью Batch 6): «СДЭК Pay» — оплата на ПВЗ
 * при получении, онлайн-инициации платежа нет (витрина зовёт initPayment ТОЛЬКО для
 * card/sbp), поэтому модуль payments ей не нужен. Иначе магазин с СДЭК, но без
 * эквайринга Т-Банк (payments off) не мог бы принять легитимный заказ cdek_pay.
 */
export const ONLINE_PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'sbp'];

/**
 * Требует ли способ оплаты включённого модуля payments (онлайн-инициация Т-Банк).
 * Баг #33: card/sbp невозможно оплатить при выключенном модуле payments.
 */
export function isOnlinePaymentMethod(method: PaymentMethod): boolean {
  return ONLINE_PAYMENT_METHODS.includes(method);
}

export type CreateOrderResult =
  | { ok: true; order: Order; reused: boolean }
  | {
      ok: false;
      code:
        | 'out_of_stock'
        | 'invalid_item'
        | 'invalid_promo'
        | 'delivery_unavailable'
        | 'payments_disabled';
      message: string;
    };

/**
 * Создаёт заказ атомарно (ADR-010, §4.2):
 *  1) ре-валидация цен/остатков ЗАНОВО из каталога (вне транзакции — чтение);
 *  2) транзакция: атомарный резерв всех позиций (gonko-safe), выдача номера,
 *     вставка orders+order_items (снимок), история(new), учёт промокода;
 *  3) идемпотентность по idempotency_key (повтор → существующий заказ).
 */
export async function createOrder(
  input: CreateOrderInput,
  ctx: CreateOrderContext = {},
): Promise<CreateOrderResult> {
  // Баг #33 (аудит тупиков): онлайн-метод оплаты (card/sbp — инициация Т-Банк) при
  // ВЫКЛЮЧЕННОМ модуле payments → заведомо тупиковый заказ (init оплаты вернёт
  // 404, заказ навсегда «ожидает оплаты»). Отсекаем ДО создания заказа: 422
  // payments_disabled (route мапит non-out_of_stock в 422). Модули orders и
  // payments независимы (lib/config/modules), поэтому такая конфигурация реальна.
  // Проверка идёт ПЕРВОЙ — до любого обращения к БД.
  if (
    isOnlinePaymentMethod(input.paymentMethod) &&
    !(await isModuleEffectivelyEnabled('payments'))
  ) {
    return {
      ok: false,
      code: 'payments_disabled',
      message:
        'Онлайн-оплата недоступна: приём платежей отключён. ' +
        'Выберите оплату при получении или свяжитесь с магазином.',
    };
  }

  const env = getEnv();
  const now = ctx.now ?? new Date();
  const source = ctx.source ?? 'storefront';
  // Порог бесплатной доставки — из эффективных настроек (env ⊕ БД), docs/11 §5.4.4.
  // Копейки → рубли (fromMinor) на границе legacy-расчёта (money-инвариант §7).
  const eff = await getEffectiveSettings();
  const freeThreshold = Number(fromMinor(eff.delivery.freeDeliveryThreshold));

  // Идемпотентность: если такой ключ уже есть — вернуть существующий заказ.
  if (input.idempotencyKey) {
    const existing = await sql<Record<string, unknown>[]>`
      SELECT * FROM orders WHERE idempotency_key = ${input.idempotencyKey} LIMIT 1
    `;
    if (existing[0]) {
      return { ok: true, order: mapOrder(existing[0]), reused: true };
    }
  }

  // Ре-валидация цен/остатков из каталога (чтение, anti-tamper).
  const resolved: ResolvedLine[] = [];
  for (const item of input.items) {
    const res = await resolveCartLine(item);
    if (!res.ok) {
      // Понятный покупателю текст вместо сырого кода (`out_of_stock` и т.п.) —
      // единый словарь cart-messages (общий корень разбора дефектов).
      return { ok: false, code: 'invalid_item', message: cartLineIssueMessage(res.reason) };
    }
    resolved.push(res.line);
  }

  // Расчёт итога (промокод валидируем заново внутри по актуальным счётчикам).
  const itemsMinor = resolved.reduce((a, l) => a + toMinor(l.unitPrice) * l.qty, 0);
  let appliedPromo: AppliedPromo | null = null;
  let promoRow: PromoCode | null = null;
  let scopeTargets: PromoScopeTargets = emptyScopeTargets();
  if (input.promoCode) {
    const found = await getPromoWithTargets(input.promoCode, input.customer.email);
    if (!found) {
      return { ok: false, code: 'invalid_promo', message: 'Промокод не найден.' };
    }
    // minQty сверяем с кол-вом единиц В SCOPE (та же разметка lineInScope, что и
    // расчёт скидки) — баг A волны 7: иначе scoped-промокод проходил валидацию,
    // но давал 0-скидку и зря потреблял used_count/слот лимита покупателя.
    const qtyForMinQty = scopedQty(
      resolved,
      found.promo.applyScope ?? 'cart',
      found.scopeTargets,
    );
    const v = validatePromo(found.promo, {
      itemsTotal: fromMinor(itemsMinor),
      itemsQty: qtyForMinQty,
      now,
      usedCount: found.promo.usedCount,
      customerRedemptions: found.customerRedemptions,
    });
    if (!v.valid) {
      return { ok: false, code: 'invalid_promo', message: v.message };
    }
    appliedPromo = v.promo;
    promoRow = found.promo;
    scopeTargets = found.scopeTargets;
  }

  // СОЗДАНИЕ заказа: НЕ softFail. Сбой нужного расчёта доставки → бросок
  // DeliveryCalculationError (anti-undercharge). Конвертируем в доменный
  // {ok:false} — контракт createOrder не бросает доменные ошибки, а runStorefront
  // не оборачивает throw (стал бы 500); admin-обёртка перекинет как OrderError.
  let deliveryCost: string;
  try {
    deliveryCost = (
      await resolveDeliveryCost({
        deliveryType: input.delivery.type,
        lines: resolved,
        city: input.delivery.city,
        cityCode: input.delivery.cityCode,
        pvzCode: input.delivery.pvzCode,
      })
    ).cost;
  } catch (e) {
    if (e instanceof DeliveryCalculationError) {
      return { ok: false, code: 'delivery_unavailable', message: e.message };
    }
    throw e;
  }

  const quote = calculateQuote({
    lines: resolved,
    promo: appliedPromo,
    delivery: {
      cost: deliveryCost,
      freeThreshold,
    },
    scopeTargets,
  });

  // Подарок (gift_*): резолвим каталожную строку подарка ДО транзакции (чтение).
  // Резерв и вставка — в транзакции ниже (best-effort: нет остатка → без подарка).
  // promoHadEffect вычисляется ВНУТРИ транзакции (после фактического резерва подарка,
  // C6-3) — иначе лимит съедался бы по giftLine!=null, даже если подарок не выдан.
  const giftLine: ResolvedLine | null = promoRow ? await resolveGiftLine(promoRow) : null;

  try {
    const order = await sql.begin(async (tx) => {
      // Повторная проверка идемпотентности внутри транзакции (гонка двух запросов).
      if (input.idempotencyKey) {
        const dup = await tx<Record<string, unknown>[]>`
          SELECT * FROM orders WHERE idempotency_key = ${input.idempotencyKey} LIMIT 1
        `;
        if (dup[0]) {
          return { row: dup[0], reused: true } as const;
        }
      }

      // 1) Атомарный резерв всех позиций. Любая нехватка → throw → ROLLBACK.
      for (const l of resolved) {
        const ok = await reserveUnit(tx, {
          productId: l.productId,
          variantId: l.variantId,
          qty: l.qty,
        });
        if (!ok) {
          throw new OutOfStockError(l.sku);
        }
      }

      // 1b) Подарок (gift_*) — best-effort резерв ДО блока лимита (C6-3). Нужен
      //     ФАКТ резерва: лимит промокода (used_count + promo_redemptions) расходуется
      //     ТОЛЬКО при реальном эффекте (баг A волны 7). Эффект = денежная скидка /
      //     бесплатная доставка (quote.promo.applied) ЛИБО РЕАЛЬНО зарезервированный
      //     подарок. Прежде эффект считался по giftLine != null (до резерва) → gift-only
      //     промокод при отсутствии остатка подарка съедал per_customer_limit, не выдав
      //     ничего (нулевой эффект жёг лимит). Резерв подарка не валит заказ при нехватке.
      let giftReserved = false;
      if (giftLine) {
        giftReserved = await reserveUnit(tx, {
          productId: giftLine.productId,
          variantId: giftLine.variantId,
          qty: giftLine.qty,
        });
      }
      const promoHadEffect = Boolean(promoRow) && (quote.promo.applied || giftReserved);

      // 2) Промокод: атомарный инкремент used_count с проверкой ГЛОБАЛЬНОГО лимита
      //    (гонка). Важный побочный эффект: этот UPDATE берёт блокировку строки
      //    promo_codes, поэтому конкурентные чекауты ТОГО ЖЕ промокода
      //    сериализуются здесь — второй ждёт коммита/отката первого. На этом и
      //    строится атомарная проверка per_customer_limit ниже (2b).
      //    Только при реальном эффекте промокода (promoHadEffect) — 0-эффект не
      //    потребляет слот лимита (баг A волны 7, доп. защита целостности).
      if (promoRow && promoHadEffect) {
        const inc = await tx<{ used_count: number }[]>`
          UPDATE promo_codes
             SET used_count = used_count + 1, updated_at = now()
           WHERE id = ${promoRow.id}
             AND (usage_limit IS NULL OR used_count < usage_limit)
          RETURNING used_count
        `;
        if (inc.length !== 1) {
          throw new PromoExhaustedError();
        }

        // 2b) Лимит на одного покупателя (per_customer_limit) — АТОМАРНО, закрывает
        //     гонку N1. Предтранзакционная проверка в validatePromo (по
        //     customerRedemptions) даёт быстрый отказ, но НЕ защищает от двух
        //     одновременных чекаутов одного email: оба видят count < limit и оба
        //     создают заказ. Здесь же мы УЖЕ под блокировкой строки promo_codes
        //     (UPDATE выше), значит конкурентный чекаут того же кода либо ещё не
        //     дошёл до этого места, либо уже закоммитил свою promo_redemptions —
        //     и повторный подсчёт это увидит (READ COMMITTED читает закоммиченное).
        if (promoRow.perCustomerLimit != null) {
          const [cnt] = await tx<{ n: string }[]>`
            SELECT count(*)::text AS n FROM promo_redemptions
             WHERE promo_code_id = ${promoRow.id}
               AND customer_email = ${input.customer.email}
          `;
          if (Number(cnt!.n) >= promoRow.perCustomerLimit) {
            throw new PromoCustomerLimitError();
          }
        }
      }

      // 3) Номер заказа (атомарно).
      const number = await nextOrderNumber(tx, now);

      // 4) Вставка заголовка заказа (суммы — серверные, ADR-010).
      const [orderRow] = await tx<Record<string, unknown>[]>`
        INSERT INTO orders (
          number, status, items_total, discount_total, delivery_total, grand_total,
          currency, payment_method, payment_status, delivery_type, delivery_city,
          delivery_address, delivery_pvz_code, delivery_cost, promo_code_id, promo_code,
          customer_name, customer_email, customer_phone, comment, idempotency_key,
          source, ip
        ) VALUES (
          ${number}, 'new', ${quote.itemsTotal}, ${quote.discount}, ${quote.deliveryCost},
          ${quote.grandTotal}, ${env.SHOP_CURRENCY}, ${input.paymentMethod}, 'pending',
          ${input.delivery.type}, ${input.delivery.city ?? null},
          ${input.delivery.address ?? null}, ${input.delivery.pvzCode ?? null},
          ${quote.deliveryCost}, ${promoRow?.id ?? null}, ${appliedPromo?.code ?? null},
          ${input.customer.name}, ${input.customer.email}, ${input.customer.phone},
          ${input.comment ?? ''}, ${input.idempotencyKey ?? null}, ${source}, ${ctx.ip ?? null}
        )
        RETURNING *
      `;
      const orderId = String(orderRow!.id);

      // 5) Позиции (СНИМОК каталога, ADR-010).
      for (let i = 0; i < resolved.length; i++) {
        const l = resolved[i]!;
        const lineTotal = fromMinor(toMinor(l.unitPrice) * l.qty);
        await tx`
          INSERT INTO order_items (
            order_id, product_id, variant_id, name_snapshot, sku_snapshot,
            attributes_snapshot, unit_price, compare_at_snapshot, quantity, line_total, is_gift,
            weight_g, length_cm, width_cm, height_cm
          ) VALUES (
            ${orderId}, ${l.productId}, ${l.variantId}, ${l.name}, ${l.sku},
            ${tx.json(l.attributesSnapshot as Record<string, never>)}, ${l.unitPrice}, ${l.compareAt},
            ${l.qty}, ${lineTotal}, false,
            ${l.weightG}, ${l.lengthCm}, ${l.widthCm}, ${l.heightCm}
          )
        `;
      }

      // 6) Учёт применения промокода (идемпотентность по UNIQUE(promo,order)).
      //    Только при реальном эффекте (promoHadEffect) — слот per-customer-лимита
      //    не расходуется на промокод с нулевым эффектом (баг A волны 7).
      if (promoRow && promoHadEffect) {
        await tx`
          INSERT INTO promo_redemptions (promo_code_id, order_id, customer_email, discount_applied)
          VALUES (${promoRow.id}, ${orderId}, ${input.customer.email}, ${quote.discount})
          ON CONFLICT (promo_code_id, order_id) DO NOTHING
        `;
      }

      // 6b) Подарок (gift_*) — резерв уже выполнен в (1b). Вставляем подарочную строку
      //     ТОЛЬКО если подарок реально зарезервирован (giftReserved). Строка:
      //     unit_price/line_total = 0, compare_at = «ценность», is_gift=true.
      if (giftLine && giftReserved) {
        await tx`
          INSERT INTO order_items (
            order_id, product_id, variant_id, name_snapshot, sku_snapshot,
            attributes_snapshot, unit_price, compare_at_snapshot, quantity, line_total, is_gift,
            weight_g, length_cm, width_cm, height_cm
          ) VALUES (
            ${orderId}, ${giftLine.productId}, ${giftLine.variantId}, ${giftLine.name}, ${giftLine.sku},
            ${tx.json(giftLine.attributesSnapshot as Record<string, never>)}, ${fromMinor(0)},
            ${giftLine.unitPrice}, ${giftLine.qty}, ${fromMinor(0)}, true,
            ${giftLine.weightG}, ${giftLine.lengthCm}, ${giftLine.widthCm}, ${giftLine.heightCm}
          )
        `;
      }

      // 7) Начальная запись истории статуса.
      await tx`
        INSERT INTO order_status_history (order_id, kind, from_status, to_status, actor_user_id, comment)
        VALUES (${orderId}, 'order', NULL, 'new', ${ctx.actorUserId ?? null}, '')
      `;

      return { row: orderRow!, reused: false } as const;
    });

    return { ok: true, order: mapOrder(order.row), reused: order.reused };
  } catch (err) {
    if (err instanceof OutOfStockError) {
      return { ok: false, code: 'out_of_stock', message: `Недостаточно остатка: ${err.sku}.` };
    }
    if (err instanceof PromoExhaustedError) {
      return { ok: false, code: 'invalid_promo', message: 'Лимит промокода исчерпан.' };
    }
    if (err instanceof PromoCustomerLimitError) {
      return {
        ok: false,
        code: 'invalid_promo',
        message: 'Лимит промокода на одного покупателя исчерпан.',
      };
    }
    // BUG #2 (reliability): гонка идемпотентного создания. Предтранзакционная
    // проверка ключа (выше) не видит чужую вставку, ещё не закоммиченную; INSERT
    // в транзакции нарывается на UNIQUE orders_idempotency_uniq (23505). Это НЕ
    // ошибка клиента — заказ уже создан конкурентным запросом с тем же ключом:
    // перечитываем его и возвращаем как успешный идемпотентный повтор (reused).
    // Конфликт без ключа (иной индекс) НЕ маскируем — пробрасываем как есть.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await sql<Record<string, unknown>[]>`
        SELECT * FROM orders WHERE idempotency_key = ${input.idempotencyKey} LIMIT 1
      `;
      if (existing[0]) {
        return { ok: true, order: mapOrder(existing[0]), reused: true };
      }
    }
    throw err;
  }
}

class OutOfStockError extends Error {
  constructor(public readonly sku: string) {
    super(`out_of_stock:${sku}`);
  }
}
class PromoExhaustedError extends Error {}
class PromoCustomerLimitError extends Error {}

// =============================================================================
// Чтения заказов (админка/storefront).
// =============================================================================

export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
}

/** Заказ по номеру + позиции; null если нет. */
export async function getOrderByNumber(number: string): Promise<OrderWithItems | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM orders WHERE number = ${number} LIMIT 1
  `;
  if (!rows[0]) return null;
  const order = mapOrder(rows[0]);
  const itemRows = await sql<Record<string, unknown>[]>`
    SELECT * FROM order_items WHERE order_id = ${order.id} ORDER BY created_at, id
  `;
  return { order, items: itemRows.map(mapOrderItem) };
}

/** Заказ по id + позиции; null если нет. */
export async function getOrderById(id: string): Promise<OrderWithItems | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM orders WHERE id = ${id} LIMIT 1
  `;
  if (!rows[0]) return null;
  const order = mapOrder(rows[0]);
  const itemRows = await sql<Record<string, unknown>[]>`
    SELECT * FROM order_items WHERE order_id = ${order.id} ORDER BY created_at, id
  `;
  return { order, items: itemRows.map(mapOrderItem) };
}

export interface ListOrdersFilter {
  q?: string;
  status?: Order['status'];
  paymentStatus?: Order['paymentStatus'];
  promoCodeId?: string;
  limit?: number;
  offset?: number;
}

/** Список заказов с фильтрами (для админки/storefront). */
export async function listOrders(
  filter: ListOrdersFilter = {},
): Promise<{ rows: Order[]; total: number }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const q = filter.q ? `%${filter.q}%` : null;

  const where = sql`
    WHERE (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.paymentStatus ?? null}::text IS NULL OR payment_status = ${filter.paymentStatus ?? null})
      AND (${filter.promoCodeId ?? null}::uuid IS NULL OR promo_code_id = ${filter.promoCodeId ?? null})
      AND (${q}::text IS NULL OR number ILIKE ${q} OR customer_email ILIKE ${q} OR customer_phone ILIKE ${q})
  `;

  const [totalRows, rows] = await Promise.all([
    sql<{ n: string }[]>`SELECT count(*)::text AS n FROM orders ${where}`,
    sql<Record<string, unknown>[]>`
      SELECT * FROM orders ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
  ]);

  return { rows: rows.map(mapOrder), total: Number(totalRows[0]?.n ?? 0) };
}
