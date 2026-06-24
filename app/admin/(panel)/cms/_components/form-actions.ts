'use server';

import {
  createCmsPage,
  updateCmsPage,
  deleteCmsPage,
  publishCmsPage,
  unpublishCmsPage,
  upsertCmsSection,
  reorderCmsSections,
  setCmsSectionEnabled,
  deleteCmsSection,
} from '@/lib/cms/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions CMS (lib/cms/actions) — образец
 * catalog/_components/form-actions.ts.
 *
 * Назначение: дать клиентским формам ('use client') стабильные серверные
 * функции для прямого импорта/вызова. Бизнес-логика, guard (cms.write),
 * assertCmsEnabled, Zod-валидация, серверная санитизация rich-text, аудит и
 * инвалидация — всё внутри defineAction в lib/cms/actions; здесь НЕ дублируется.
 */

// --- Страницы ---------------------------------------------------------------

export async function createCmsPageAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return createCmsPage(input);
}
export async function updateCmsPageAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return updateCmsPage(input);
}
export async function deleteCmsPageAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return deleteCmsPage(input);
}
export async function publishCmsPageAction(
  input: unknown,
): Promise<ActionResult<{ id: string; revision: number }>> {
  return publishCmsPage(input) as Promise<ActionResult<{ id: string; revision: number }>>;
}
export async function unpublishCmsPageAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return unpublishCmsPage(input);
}

// --- Секции -----------------------------------------------------------------

export async function upsertCmsSectionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return upsertCmsSection(input);
}
export async function reorderCmsSectionsAction(
  input: unknown,
): Promise<ActionResult<{ pageId: string }>> {
  return reorderCmsSections(input);
}
export async function setCmsSectionEnabledAction(
  input: unknown,
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return setCmsSectionEnabled(input);
}
export async function deleteCmsSectionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return deleteCmsSection(input);
}
