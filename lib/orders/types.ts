/**
 * Доменные типы заказов (docs/07 §2 «Схема БД»).
 *
 * Типы прикладного уровня (camelCase), отображающие строки таблиц модуля orders.
 * Маппинг row(snake_case)→domain(camelCase) — в repository.ts (пакет 3.B).
 * Деньги моделируются строкой (NUMERIC(14,2) приходит из postgres.js строкой,
 * чтобы не терять точность); парсинг в число — на уровне представления/расчёта.
 *
 * Перечисления статусов/способов соответствуют CHECK-ограничениям миграций
 * 0012–0016 и whitelist-переходам в status.ts.
 */

// -----------------------------------------------------------------------------
// Перечисления / литеральные типы (== CHECK-ограничения в БД).
// -----------------------------------------------------------------------------

/** Статус заказа (orders.status, §2.8 A). */
export type OrderStatus =
  | 'new'
  | 'awaiting_payment'
  | 'paid'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refunded';
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'awaiting_payment',
  'paid',
  'packed',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
] as const;

/** Статус оплаты (orders.payment_status, §2.8 B). */
export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'refunded';
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
] as const;

/** Статус доставки (orders.delivery_status, §2.8 C; источник истины — СДЭК Этап 4). */
export type DeliveryStatus =
  | 'pending'
  | 'registered'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'cancelled';
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'registered',
  'in_transit',
  'delivered',
  'returned',
  'cancelled',
] as const;

/** Способ оплаты (orders.payment_method). Онлайн-провайдеры — будущее, сейчас фиксация. */
export type PaymentMethod = 'unset' | 'cod' | 'card' | 'sbp' | 'cdek_pay' | 'invoice';
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'unset',
  'cod',
  'card',
  'sbp',
  'cdek_pay',
  'invoice',
] as const;

/** Тип доставки (orders.delivery_type): курьер / ПВЗ СДЭК / самовывоз. */
export type DeliveryType = 'courier' | 'pvz' | 'pickup';
export const DELIVERY_TYPES: readonly DeliveryType[] = [
  'courier',
  'pvz',
  'pickup',
] as const;

/** Источник создания заказа (orders.source). */
export type OrderSource = 'storefront' | 'admin';
export const ORDER_SOURCES: readonly OrderSource[] = ['storefront', 'admin'] as const;

/** К какой из трёх статус-машин относится запись истории (order_status_history.kind). */
export type StatusHistoryKind = 'order' | 'payment' | 'delivery';
export const STATUS_HISTORY_KINDS: readonly StatusHistoryKind[] = [
  'order',
  'payment',
  'delivery',
] as const;

/** Тип скидки промокода (promo_codes.kind, §3.2). */
export type PromoKind = 'percent' | 'fixed' | 'free_delivery' | 'bogo';
export const PROMO_KINDS: readonly PromoKind[] = [
  'percent',
  'fixed',
  'free_delivery',
  'bogo',
] as const;

/** На что распространяется промо-механика (promo_codes.apply_scope, §5.2.1). */
export type PromoApplyScope = 'cart' | 'category' | 'brand' | 'set';
export const PROMO_APPLY_SCOPES: readonly PromoApplyScope[] = [
  'cart',
  'category',
  'brand',
  'set',
] as const;

/** Тип таргета акции (promo_targets.target_type, §5.2.1). */
export type PromoTargetType = 'category' | 'brand' | 'product' | 'variant';
export const PROMO_TARGET_TYPES: readonly PromoTargetType[] = [
  'category',
  'brand',
  'product',
  'variant',
] as const;

// -----------------------------------------------------------------------------
// Сущности.
// -----------------------------------------------------------------------------

/** Заголовок заказа (orders, §2.1). */
export interface Order {
  id: string;
  /** Человекочитаемый уникальный номер `ПРЕФИКС-ГОД-NNNNNN` (§2.7). */
  number: string;
  status: OrderStatus;

  // ---- Суммы (NUMERIC(14,2) как строки — точность не теряется) ----
  /** Сумма позиций (с каталожной скидкой compare_at_price). */
  itemsTotal: string;
  /** Скидка промокода (фикс/процент), не доставка. */
  discountTotal: string;
  /** Стоимость доставки (0 при бесплатной/самовывозе). */
  deliveryTotal: string;
  /** Итог к оплате = itemsTotal − discountTotal + deliveryTotal. */
  grandTotal: string;
  /** Снимок валюты на момент заказа (из SHOP_CURRENCY). */
  currency: string;

  // ---- Оплата ----
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paidAt: Date | null;
  paymentRef: string | null;
  /** Платёжный провайдер (orders.payment_provider): 'tbank' | 'manual' | null. */
  paymentProvider: string | null;

  // ---- Доставка (поля под СДЭК Этап 4) ----
  deliveryType: DeliveryType;
  deliveryStatus: DeliveryStatus;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  deliveryPvzCode: string | null;
  /** Расчётная стоимость доставки (СДЭК/заглушка); null → не рассчитана. */
  deliveryCost: string | null;
  cdekUuid: string | null;
  cdekTrack: string | null;

  // ---- Промокод (ссылка + денормализованный снимок кода) ----
  promoCodeId: string | null;
  promoCode: string | null;

  // ---- Покупатель (гостевой чекаут; опц. связь с customers) ----
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;

  comment: string;

  /** Ключ идемпотентности от витрины (anti-double-submit). */
  idempotencyKey: string | null;

  source: OrderSource;
  ip: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Позиция заказа = снимок каталога на момент покупки (order_items, §2.2, ADR-010). */
export interface OrderItem {
  id: string;
  orderId: string;
  /** Ссылка на товар (навигация/аналитика); null → товар удалён, история по снимку. */
  productId: string | null;
  /** Ссылка на вариант; null → вариант удалён. */
  variantId: string | null;

  // ---- Снимок (ADR-010) ----
  nameSnapshot: string;
  skuSnapshot: string;
  attributesSnapshot: Record<string, unknown>;
  /** Эффективная цена за единицу (что платят). */
  unitPrice: string;
  /** «Было» на момент покупки (для чека/возврата); null → без акции. */
  compareAtSnapshot: string | null;

  quantity: number;
  /** = unitPrice × quantity (считает сервер). */
  lineTotal: string;

  /** Подарочная позиция (промокод gift_*): unitPrice/lineTotal = 0. */
  isGift: boolean;

  // ---- Снимок веса/габаритов для СДЭК (0026, резолв вариант→товар) ----
  /** Вес единицы в граммах на момент покупки; null → дефолт магазина (CDEK_DEFAULT_*). */
  weightG: number | null;
  /** Габариты единицы в см на момент покупки; null → дефолт магазина. */
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;

  createdAt: Date;
}

/** Запись доменной истории смены статуса (order_status_history, §2.3). */
export interface OrderStatusHistory {
  id: string;
  orderId: string;
  /** Какая из трёх статус-машин сменилась. */
  kind: StatusHistoryKind;
  /** null для первой записи (создание). */
  fromStatus: string | null;
  toStatus: string;
  /** Кто сменил; null → система/витрина. */
  actorUserId: string | null;
  comment: string;
  createdAt: Date;
}

/** Покупатель — задел под ЛК/агрегацию заказов (customers, §2.4). */
export interface Customer {
  id: string;
  email: string;
  phone: string | null;
  name: string;
  ordersCount: number;
  totalSpent: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Промокод (promo_codes, §2.5, §3). */
export interface PromoCode {
  id: string;
  code: string;
  kind: PromoKind;
  /** percent → проценты 0..100; fixed → сумма; free_delivery → игнор; bogo → см. bogo*. */
  value: string;

  // ---- Условия ----
  minOrderTotal: string;
  /** Потолок скидки (для percent); null → без потолка. */
  maxDiscount: string | null;

  // ---- Лимиты ----
  /** Лимит всего; null → без лимита. */
  usageLimit: number | null;
  /** Лимит на покупателя (по email); null → без лимита. */
  perCustomerLimit: number | null;
  usedCount: number;

  // ---- Срок и активность ----
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;

  // ---- Задел под BOGO «N по M» (исполнение — Этап 5.2) ----
  bogoBuyQty: number | null;
  bogoPayQty: number | null;

  // ---- N×M промо-механики (Пакет 5.P-1) ----
  /** На что распространяется механика (cart/category/brand/set). */
  applyScope: PromoApplyScope;
  /** Порядок применения (меньше = раньше); tie-break по code. */
  priority: number;
  /** Комбинируемость (false → эксклюзивна). */
  stackable: boolean;
  /** Qty-порог (дополняет minOrderTotal); null → без порога. */
  minQty: number | null;
  /** Товар-подарок — задел (исполнение отложено). */
  giftProductId: string | null;
  giftVariantId: string | null;
  giftQty: number | null;

  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Таргет акции (promo_targets, §5.2.1) — к чему применяется scope/N×M-группировка. */
export interface PromoTarget {
  id: string;
  promoCodeId: string;
  targetType: PromoTargetType;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  variantId: string | null;
  createdAt: Date;
}

/** Факт применения промокода (promo_redemptions, §2.6, §3.4). */
export interface PromoRedemption {
  id: string;
  promoCodeId: string;
  orderId: string;
  customerEmail: string;
  /** Фактическая скидка (для отчётов/возврата). */
  discountApplied: string;
  createdAt: Date;
}

/** Строка таблицы-нумератора заказов (order_number_counters, §2.7). */
export interface OrderNumberCounter {
  /** Область счётчика — обычно год ('2026') или 'global'. */
  scope: string;
  lastValue: number;
}
