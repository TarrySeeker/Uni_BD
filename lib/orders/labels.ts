/**
 * Канонические РУССКИЕ подписи статусов заказа/оплаты/доставки (G-15).
 *
 * ЕДИНЫЙ источник истины: использует и админка (lib/admin/order-format реэкспортит),
 * и публичный DTO заказа (lib/storefront/order-dto добавляет *Label в ответ витрине).
 * Раньше витрина держала свою карту подписей и расходилась с админкой
 * (shipped: «Отправлен» vs «Отгружен» — аудит docs/18, G-15). Теперь подпись одна.
 *
 * Record по литералам типов → исчерпывающая проверка компилятором; незнакомый код
 * безопасно возвращается как есть (фолбэк).
 */
import type { OrderStatus, PaymentStatus, DeliveryStatus } from '@/lib/orders/types';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'Новый',
  awaiting_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  packed: 'Собран',
  shipped: 'Отгружен',
  delivered: 'Доставлен',
  completed: 'Завершён',
  cancelled: 'Отменён',
  refunded: 'Возврат',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Ожидает',
  authorized: 'Авторизована',
  paid: 'Оплачена',
  failed: 'Ошибка',
  refunded: 'Возврат',
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: 'Ожидает',
  registered: 'Зарегистрирована',
  in_transit: 'В пути',
  delivered: 'Доставлена',
  returned: 'Возврат',
  cancelled: 'Отменена',
};

/** Безопасный поиск подписи: незнакомый код → сам код (фолбэк, без падения). */
function label<T extends string>(map: Record<T, string>, code: string): string {
  return (map as Record<string, string>)[code] ?? code;
}

export function orderStatusLabel(status: string): string {
  return label(ORDER_STATUS_LABEL, status);
}
export function paymentStatusLabel(status: string): string {
  return label(PAYMENT_STATUS_LABEL, status);
}
export function deliveryStatusLabel(status: string): string {
  return label(DELIVERY_STATUS_LABEL, status);
}
