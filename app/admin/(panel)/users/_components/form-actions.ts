'use server';

import {
  createUser,
  updateUser,
  resetUserPassword,
} from '@/lib/auth/admin-actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions пользователей (lib/auth/
 * admin-actions). Дают клиентским формам ('use client') стабильные серверные
 * функции для прямого вызова. Бизнес-логика, guard (users.manage), Zod, аудит и
 * инвалидация — всё внутри defineAction; здесь только проксирование.
 */

export async function createUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createUser(input);
}
export async function updateUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateUser(input);
}
export async function resetUserPasswordAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return resetUserPassword(input);
}
