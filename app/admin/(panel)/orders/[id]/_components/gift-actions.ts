'use server';

import { issueGiftFromOrder } from '@/lib/gift-certificates';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкая серверная обёртка над issueGiftFromOrder для блока сертификата в
 * карточке заказа. Право gift.write, Zod, номинал из снимка позиции, аудит и
 * инвалидация — внутри defineAction; здесь только проксирование.
 */
export async function issueGiftFromOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; code: string; initialAmount: string }>> {
  return issueGiftFromOrder(input);
}
