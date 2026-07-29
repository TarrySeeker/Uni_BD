'use server';

import { resendMail } from '@/lib/mail/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкая серверная обёртка над Server Action раздела «Письма» — даёт клиентскому
 * компоненту ('use client') стабильную функцию для импорта.
 *
 * Бизнес-логика, guard (orders.write), Zod, пересборка письма, аудит и
 * инвалидация — внутри defineAction в lib/mail/actions; здесь только
 * проксирование (паттерн subscribers/_components/subscriber-actions.ts).
 */
export async function resendMailAction(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return resendMail(input);
}
