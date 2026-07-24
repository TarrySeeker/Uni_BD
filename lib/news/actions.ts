'use server';

/**
 * Server Actions среза «Новости» (docs/24 §3) — прод-обёртки.
 *
 * Файл 'use server' экспортирует ТОЛЬКО async-функции. Фабрика (createNewsActions),
 * типы зависимостей (NewsActionDeps), прод-зависимости (productionNewsDeps) и
 * вспомогательные не-async функции — в lib/news/action-factory.ts (эталон
 * lib/settings/action-factory). Здесь — тонкие async-обёртки над прод-экземпляром
 * плюс загрузка обложки (Server Action из FormData).
 */

import {
  defineAction,
  PublicActionError,
} from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { z } from 'zod';
import { getStorage } from '@/lib/storage';
import { validateUpload } from '@/lib/storage/validate';
import { generatePreviews } from '@/lib/storage/image';

import { NewsError } from './errors';
import { createNewsActions, productionNewsDeps } from './action-factory';

// =============================================================================
// ЗАГРУЗКА ОБЛОЖКИ НОВОСТИ (ADR-018, образец lib/cms uploadCmsImage).
// =============================================================================

const NewsImageUploadSchema = z.object({
  filename: z.string().max(255).optional().default('upload'),
  bytes: z.instanceof(Buffer),
});

/**
 * Внутренний action загрузки обложки: пайплайн медиа (validateUpload magic-bytes →
 * generatePreviews webp → storage.put). ВОЗВРАЩАЕТ S3-ключ (news хранит cover_image_key,
 * не URL). Ключ генерируется сервером (анти-path-traversal): news/<uuid>.webp.
 */
const _uploadNewsImage = defineAction({
  permission: 'news.write',
  input: NewsImageUploadSchema,
  handler: async (data) => {
    if (!(await isModuleEffectivelyEnabled('news'))) {
      throw new NewsError('module_disabled', 'Модуль «Новости» выключен.');
    }

    const validation = await validateUpload(data.bytes, data.filename);
    if (!validation.ok || !validation.mime) {
      throw new PublicActionError(validation.error ?? 'errors.newsActions.invalidFile');
    }

    const previews = await generatePreviews(data.bytes);
    const storage = getStorage();
    const key = `news/${crypto.randomUUID()}.webp`;
    let put;
    try {
      put = await storage.put(key, previews.main.buffer, 'image/webp');
    } catch {
      throw new PublicActionError('errors.newsActions.storageSaveFailed');
    }

    return {
      result: { key: put.key, url: put.url },
      audit: {
        action: 'news.image.upload',
        entityType: 'news_image',
        entityId: put.key,
        after: { key: put.key },
      },
    };
  },
});

/** Загрузка обложки новости из FormData (Server Action для формы). */
export async function uploadNewsImageAction(formData: FormData) {
  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return _uploadNewsImage({ filename: 'upload', bytes: undefined });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const filename = file instanceof File ? file.name : 'upload';
  return _uploadNewsImage({ filename, bytes });
}

// Прод-инстанс (тонкие обёртки для form-actions).
const prodActions = createNewsActions(productionNewsDeps());
export const createNews = prodActions.createNews;
export const updateNewsArticle = prodActions.updateNews;
export const setNewsStatus = prodActions.setNewsStatus;
export const deleteNewsArticle = prodActions.deleteNews;
