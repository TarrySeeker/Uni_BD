'use server';

import {
  createAttribute,
  updateAttribute,
  addAttributeValue,
  deleteAttributeValue,
} from '@/lib/catalog/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions справочника характеристик
 * (lib/catalog/actions). Дают клиентским формам ('use client') стабильные
 * серверные функции для прямого вызова.
 *
 * Guard (catalog.write), Zod-валидация, аудит и инвалидация (ATTRIBUTES_PATH) —
 * всё внутри defineAction в lib/catalog/actions; здесь НЕ дублируется,
 * только проксируется (как соседний catalog/_components/form-actions.ts).
 */

export async function createAttributeAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return createAttribute(input);
}

export async function updateAttributeAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return updateAttribute(input);
}

export async function addAttributeValueAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return addAttributeValue(input);
}

export async function deleteAttributeValueAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return deleteAttributeValue(input);
}
