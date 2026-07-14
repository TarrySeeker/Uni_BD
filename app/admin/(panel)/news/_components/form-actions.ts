'use server';

import {
  createNews,
  updateNewsArticle,
  setNewsStatus,
  deleteNewsArticle,
  uploadNewsImageAction as uploadNewsImage,
} from '@/lib/news/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions новостей (lib/news/actions) —
 * образец cms/_components/form-actions. Guard (news.write), assertNewsEnabled,
 * Zod-валидация, санитизация rich-text, i18n-оверлей, аудит и инвалидация — всё
 * внутри defineAction в lib/news/actions; здесь НЕ дублируется.
 */

export async function createNewsAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return createNews(input);
}
export async function updateNewsAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return updateNewsArticle(input);
}
export async function setNewsStatusAction(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return setNewsStatus(input) as Promise<ActionResult<{ id: string; status: string }>>;
}
export async function deleteNewsAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return deleteNewsArticle(input);
}

/** Загрузка обложки новости (FormData с полем `file`) → S3-ключ (news.write). */
export async function uploadNewsCoverAction(
  formData: FormData,
): Promise<ActionResult<{ key: string; url: string }>> {
  return uploadNewsImage(formData) as Promise<ActionResult<{ key: string; url: string }>>;
}
