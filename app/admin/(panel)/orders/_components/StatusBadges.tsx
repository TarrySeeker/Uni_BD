import { getTranslations } from 'next-intl/server';

import {
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
} from '@/lib/orders/labels';
import {
  orderStatusBadgeClass,
  paymentStatusBadgeClass,
  deliveryStatusBadgeClass,
} from '@/lib/admin/order-format';

/**
 * Презентационные бейджи статусов заказа/оплаты/доставки (серверные компоненты,
 * без 'use client'). Цвет-классы — из lib/admin/order-format (единый источник).
 *
 * 🔴 Подпись резолвится ПО КЛЮЧУ каталога через next-intl (аудит major №28):
 * раньше печаталась готовая РУССКАЯ строка из lib/orders/labels, и оператор с
 * интерфейсом на en/fr всё равно видел «Отгружен». Язык оператора (cookie
 * NEXT_LOCALE) независим от языка покупателя на витрине.
 *
 * Незнакомый код: ключа нет → печатаем сам код (прежний безопасный фолбэк).
 */

const BADGE_BASE =
  'inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export async function OrderStatusBadge({ status }: { status: string }) {
  const t = await getTranslations();
  const key = orderStatusLabelKey(status);
  return (
    <span className={`${BADGE_BASE} ${orderStatusBadgeClass(status)}`}>
      {key ? t(key) : status}
    </span>
  );
}

export async function PaymentStatusBadge({ status }: { status: string }) {
  const t = await getTranslations();
  const key = paymentStatusLabelKey(status);
  return (
    <span className={`${BADGE_BASE} ${paymentStatusBadgeClass(status)}`}>
      {key ? t(key) : status}
    </span>
  );
}

export async function DeliveryStatusBadge({ status }: { status: string }) {
  const t = await getTranslations();
  const key = deliveryStatusLabelKey(status);
  return (
    <span className={`${BADGE_BASE} ${deliveryStatusBadgeClass(status)}`}>
      {key ? t(key) : status}
    </span>
  );
}
