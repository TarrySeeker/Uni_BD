/**
 * Презентационные форматтеры модуля orders для UI админки (docs/07 §5).
 *
 * Чистые функции без БД/Next — тестируемы юнитом (tests/admin/order-format.test.ts).
 * Назначение: единый источник РУССКИХ лейблов статусов заказа/оплаты/доставки,
 * способов доставки/оплаты, типов промокодов, а также цветовых классов бейджей.
 * Цены НЕ форматируются здесь — это делает formatPrice (lib/admin/format.ts),
 * валюта берётся из SHOP_CURRENCY (без хардкода ₽).
 *
 * Лейблы покрывают все литералы из lib/orders/types.ts (== CHECK-ограничения БД);
 * незнакомый код безопасно отображается как есть (фолбэк), бейдж не падает.
 */

import type {
  DeliveryStatus,
  DeliveryType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PromoKind,
  StatusHistoryKind,
} from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Лейблы (русский). Record по литералам → исчерпывающая проверка компилятором.
// -----------------------------------------------------------------------------

// Подписи статусов заказа/оплаты/доставки — единый источник lib/orders/labels
// (G-15): используются и здесь (админка), и в публичном DTO заказа (витрина).
const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = {
  courier: 'Курьер',
  pvz: 'ПВЗ',
  pickup: 'Самовывоз',
};

const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  unset: 'Не выбран',
  cod: 'При получении',
  card: 'Карта',
  sbp: 'СБП',
  cdek_pay: 'СДЭК Pay',
  invoice: 'Счёт',
};

const PROMO_KIND_LABEL: Record<PromoKind, string> = {
  percent: 'Процент',
  fixed: 'Фикс. сумма',
  free_delivery: 'Бесплатная доставка',
  bogo: 'N по M',
};

const HISTORY_KIND_LABEL: Record<StatusHistoryKind, string> = {
  order: 'Заказ',
  payment: 'Оплата',
  delivery: 'Доставка',
};

/** Безопасный поиск лейбла: незнакомый код → сам код (фолбэк, без падения). */
function label<T extends string>(map: Record<T, string>, code: string): string {
  return (map as Record<string, string>)[code] ?? code;
}

// Подписи статусов заказа/оплаты/доставки — из общего lib/orders/labels (G-15).
export {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
} from '@/lib/orders/labels';

export function deliveryTypeLabel(type: string): string {
  return label(DELIVERY_TYPE_LABEL, type);
}
export function paymentMethodLabel(method: string): string {
  return label(PAYMENT_METHOD_LABEL, method);
}
export function promoKindLabel(kind: string): string {
  return label(PROMO_KIND_LABEL, kind);
}
export function historyKindLabel(kind: string): string {
  return label(HISTORY_KIND_LABEL, kind);
}

// -----------------------------------------------------------------------------
// Цвета бейджей (Tailwind-классы). Незнакомый код → нейтральный серый.
// -----------------------------------------------------------------------------

const NEUTRAL_BADGE = 'bg-gray-100 text-gray-700';

const ORDER_STATUS_BADGE: Record<OrderStatus, string> = {
  new: 'bg-blue-100 text-blue-800',
  awaiting_payment: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
  packed: 'bg-indigo-100 text-indigo-800',
  shipped: 'bg-cyan-100 text-cyan-800',
  delivered: 'bg-teal-100 text-teal-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
  refunded: 'bg-red-100 text-red-700',
};

const PAYMENT_STATUS_BADGE: Record<PaymentStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  authorized: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-700',
  refunded: 'bg-red-100 text-red-700',
};

const DELIVERY_STATUS_BADGE: Record<DeliveryStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  registered: 'bg-blue-100 text-blue-800',
  in_transit: 'bg-cyan-100 text-cyan-800',
  delivered: 'bg-green-100 text-green-800',
  returned: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

export function orderStatusBadgeClass(status: string): string {
  return (ORDER_STATUS_BADGE as Record<string, string>)[status] ?? NEUTRAL_BADGE;
}
export function paymentStatusBadgeClass(status: string): string {
  return (PAYMENT_STATUS_BADGE as Record<string, string>)[status] ?? NEUTRAL_BADGE;
}
export function deliveryStatusBadgeClass(status: string): string {
  return (DELIVERY_STATUS_BADGE as Record<string, string>)[status] ?? NEUTRAL_BADGE;
}

// -----------------------------------------------------------------------------
// Прочие форматтеры представления.
// -----------------------------------------------------------------------------

/** Дата+время по-русски для лент истории/списка (ru-RU, без секунд). */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Человекочитаемое описание условия/значения промокода для списка
 * (например «20 %», «500 ₽», «беспл. доставка», «3 по 2»). Цены форматируются
 * вызывающим через formatPrice; здесь — компактный текст по типу.
 */
/** Человекочитаемое имя scope акции (вся корзина/категория/бренд/набор). */
export function promoScopeLabel(scope: string): string {
  switch (scope) {
    case 'cart':
      return 'Вся корзина';
    case 'category':
      return 'Категория';
    case 'brand':
      return 'Бренд';
    case 'set':
      return 'Набор';
    default:
      return scope;
  }
}

export function promoValueSummary(promo: {
  kind: string;
  value: string;
  bogoBuyQty?: number | null;
  bogoPayQty?: number | null;
}): string {
  switch (promo.kind) {
    case 'percent':
      return `${Number(promo.value)} %`;
    case 'free_delivery':
      return 'беспл. доставка';
    case 'bogo':
      return promo.bogoBuyQty && promo.bogoPayQty
        ? `${promo.bogoBuyQty} по ${promo.bogoPayQty}`
        : 'N по M';
    case 'fixed':
    default:
      return promo.value;
  }
}
