/**
 * Zod-схемы SEO-полей сущностей (docs/11 §5.3, пакет 5.S-1).
 *
 * Переиспользуются в схемах каталога (ProductUpdate/CategoryUpdate/BrandUpdate)
 * и CMS (позже). Обычный модуль (не 'use server') — содержит только схемы.
 *
 * Ключевой инвариант — `canonicalUrlSchema`: защита от open-redirect/XSS в
 * <link rel=canonical>. Принимается ТОЛЬКО:
 *   - абсолютный https-URL с непустым host (https://shop.example/...);
 *   - относительный path с ОДНИМ ведущим '/' (но НЕ protocol-relative '//host').
 * Отвергается мусор: javascript:, http:// (не https), относительный без '/',
 * пробелы, '//evil.com'. Пустая строка/undefined допустимы (поле необязательно).
 */

import { z } from 'zod';

/** Опциональный SEO-заголовок (как seo_title в каталоге). */
export const seoTitleSchema = z.string().max(255).optional();
/** Опциональное SEO-описание. */
export const seoDescriptionSchema = z.string().max(1000).optional();
/** Опциональный OG-заголовок. */
export const ogTitleSchema = z.string().max(255).optional();
/** Опциональное OG-описание. */
export const ogDescriptionSchema = z.string().max(1000).optional();
/**
 * Ключ объекта OG-изображения в хранилище (S3/MinIO). НЕ URL — URL собирает
 * storage.publicUrl на границе DTO. Допускаем nullish (снять изображение).
 */
export const ogImageKeySchema = z.string().trim().max(512).nullish();
/** Флаг noindex для сущности. */
export const noindexSchema = z.boolean().optional();

/**
 * Проверяет, что строка — безопасный canonical: абсолютный https с host или
 * относительный path с одиночным ведущим '/'. Без сетевых вызовов/БД.
 */
export function isSafeCanonical(value: string): boolean {
  // Пробелы/управляющие символы недопустимы (вектор обхода).
  if (/\s/.test(value)) return false;

  // Относительный path: ровно один ведущий '/' (не '//' — protocol-relative).
  if (value.startsWith('/')) {
    return !value.startsWith('//');
  }

  // Абсолютный: только https с непустым host. URL-парсер + явная проверка протокола.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.length > 0;
}

/**
 * canonical_url: абсолютный https ИЛИ path с '/'. Мусор → validation. Поле
 * необязательно (undefined/'' → нет canonical, автоген из slug+домена).
 */
export const canonicalUrlSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || isSafeCanonical(v), {
    message:
      'canonical_url: ожидается абсолютный https-URL или относительный путь с ведущим «/»',
  })
  .optional();
