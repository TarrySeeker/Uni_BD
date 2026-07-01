'use server';

import { unsubscribeSubscriber } from '@/lib/newsletter/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкая серверная обёртка над Server Action раздела «Подписчики» — даёт
 * клиентскому компоненту ('use client') стабильную функцию для импорта.
 * Бизнес-логика, guard (orders.write), Zod, guarded UPDATE, аудит и инвалидация —
 * внутри defineAction в lib/newsletter/actions; здесь только проксирование
 * (паттерн orders/_components/order-actions.ts).
 */
export async function unsubscribeSubscriberAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return unsubscribeSubscriber(input);
}
