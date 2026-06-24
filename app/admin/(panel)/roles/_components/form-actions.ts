'use server';

import {
  createRole,
  updateRole,
  deleteRole,
} from '@/lib/auth/admin-actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions ролей (lib/auth/admin-actions).
 * Дают клиентским формам ('use client') стабильные серверные функции для
 * прямого вызова. Бизнес-логика, guard (roles.manage), Zod, аудит и инвалидация
 * — всё внутри defineAction; здесь только проксирование.
 */

export async function createRoleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createRole(input);
}
export async function updateRoleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateRole(input);
}
export async function deleteRoleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteRole(input);
}
