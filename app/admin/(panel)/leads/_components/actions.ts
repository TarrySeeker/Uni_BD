'use server';

/**
 * Прод-обёртки Server Actions обработки заявок (G-09).
 *
 * Файл 'use server' экспортирует ТОЛЬКО async-функции. Вся логика — в фабрике
 * lib/leads/actions.ts (createLeadActions): guard (orders.write), Zod-валидация,
 * проверка перехода whitelist'ом, запись в БД, revalidate, audit. Здесь — лишь
 * тонкие async-обёртки над прод-экземпляром (реальная БД), как
 * lib/settings/actions.ts над action-factory.
 */

import {
  createLeadActions,
  productionLeadDeps,
} from '@/lib/leads/actions';
import type { ActionResult } from '@/lib/server/action';

const prod = createLeadActions(productionLeadDeps());

export async function setLeadStatusAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return prod.setLeadStatus(raw);
}

export async function deleteLeadAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  return prod.deleteLead(raw);
}
