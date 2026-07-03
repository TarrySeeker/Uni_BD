/**
 * Фабрика хранилища медиа (docs/05 §3.3).
 *
 * Выбор реализации по env:
 *  - заданы хотя бы S3_ENDPOINT + S3_BUCKET → S3Storage (боевой режим);
 *  - иначе → LocalStorage (mock/local) + одноразовый console.warn.
 *
 * Mock-режим включается автоматически, чтобы магазин без боевых S3-ключей
 * (docs/02) поднимался и проходил smoke без реального S3.
 */

import { getEnv } from '@/lib/config/env';
import type { Env } from '@/lib/config/env';
import { LocalStorage } from './local';
import { S3Storage } from './s3';
import type { ObjectStorage } from './types';

export type { ObjectStorage, PutResult, GetResult, StorageMode } from './types';
export { LocalStorage } from './local';
export { S3Storage } from './s3';
export {
  validateUpload,
  MEDIA_MAX_SIZE_BYTES,
  DEFAULT_ALLOWED_MIME,
} from './validate';
export type {
  MediaValidationResult,
  ValidateUploadOptions,
} from './validate';
export { generatePreviews, readImageMeta } from './image';
export type { PreviewSet, RenderedImage, ImageMeta } from './image';

let cached: ObjectStorage | undefined;
let warned = false;

/** Проверяет, достаточно ли env для S3-режима. */
function hasS3Config(env: Env): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_BUCKET);
}

/**
 * Создаёт хранилище на основе конфигурации (без кеша) — тестируемый выбор.
 */
export function createStorage(
  source?: Record<string, string | undefined>,
): ObjectStorage {
  const env = getEnv(source);

  if (hasS3Config(env)) {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      bucket: env.S3_BUCKET as string,
      publicUrl: env.S3_PUBLIC_URL,
    });
  }

  if (!warned) {
    warned = true;
    console.warn(
      '[storage] Хранилище медиа в mock/local-режиме: S3 не настроен ' +
        '(нет S3_ENDPOINT/S3_BUCKET). Файлы сохраняются локально.',
    );
  }
  // publicBase из S3_PUBLIC_URL — абсолютный URL медиа (напр. на admin-домене),
  // иначе относительный /media не открылся бы с домена витрины. Отдача — роут
  // app/media/[...key] (в Docker медиа отдаёт Caddy→MinIO; без Docker — приложение).
  return new LocalStorage(
    env.S3_PUBLIC_URL ? { publicBase: env.S3_PUBLIC_URL } : {},
  );
}

/**
 * Возвращает хранилище медиа. Ленивый кешируемый дефолтный инстанс.
 */
export function getStorage(
  source?: Record<string, string | undefined>,
): ObjectStorage {
  if (!cached) {
    cached = createStorage(source);
  }
  return cached;
}

/** Сбрасывает кеш и флаг предупреждения (для тестов). */
export function resetStorage(): void {
  cached = undefined;
  warned = false;
}
