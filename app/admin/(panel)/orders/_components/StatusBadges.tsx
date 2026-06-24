import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
  orderStatusBadgeClass,
  paymentStatusBadgeClass,
  deliveryStatusBadgeClass,
} from '@/lib/admin/order-format';

/**
 * Презентационные бейджи статусов заказа/оплаты/доставки (без 'use client').
 * Лейблы и цвет-классы — из lib/admin/order-format (единый источник, тестируем).
 */

const BADGE_BASE =
  'inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function OrderStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${BADGE_BASE} ${orderStatusBadgeClass(status)}`}>
      {orderStatusLabel(status)}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${BADGE_BASE} ${paymentStatusBadgeClass(status)}`}>
      {paymentStatusLabel(status)}
    </span>
  );
}

export function DeliveryStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${BADGE_BASE} ${deliveryStatusBadgeClass(status)}`}>
      {deliveryStatusLabel(status)}
    </span>
  );
}
