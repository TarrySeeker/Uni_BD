'use server';

import {
  changeOrderStatus,
  cancelOrder,
  refundOrder,
  setPaymentStatus,
  setDeliveryStatus,
  createPromoCode,
  updatePromoCode,
  deactivatePromoCode,
  deletePromoCode,
} from '@/lib/orders/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions модуля orders (lib/orders/actions).
 *
 * Назначение: дать клиентским компонентам ('use client') стабильные серверные
 * функции для импорта/вызова. Бизнес-логика, guard (orders.read/orders.write),
 * Zod-валидация, статус-машина (canTransition), резерв/списание остатков, аудит и
 * инвалидация — всё внутри defineAction в lib/orders/actions; здесь НЕ дублируется,
 * только проксируется (как catalog/_components/form-actions.ts).
 *
 * Возвращаемый тип результата приведён к unknown-данным: UI читает ok/error/message,
 * а конкретный shape result не нужен клиенту (после успеха он делает router.refresh).
 */

// --- Статус заказа / отмена / возврат ----------------------------------------

export async function changeOrderStatusAction(input: unknown): Promise<ActionResult<unknown>> {
  return changeOrderStatus(input);
}
export async function cancelOrderAction(input: unknown): Promise<ActionResult<unknown>> {
  return cancelOrder(input);
}
export async function refundOrderAction(input: unknown): Promise<ActionResult<unknown>> {
  return refundOrder(input);
}

// --- Статус оплаты / доставки -------------------------------------------------

export async function setPaymentStatusAction(input: unknown): Promise<ActionResult<unknown>> {
  return setPaymentStatus(input);
}
export async function setDeliveryStatusAction(input: unknown): Promise<ActionResult<unknown>> {
  return setDeliveryStatus(input);
}

// --- Промокоды (CRUD) ---------------------------------------------------------

export async function createPromoCodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createPromoCode(input) as Promise<ActionResult<{ id: string }>>;
}
export async function updatePromoCodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updatePromoCode(input) as Promise<ActionResult<{ id: string }>>;
}
export async function deactivatePromoCodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deactivatePromoCode(input);
}
export async function deletePromoCodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deletePromoCode(input);
}
