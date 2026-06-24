/**
 * Валидация загружаемых медиафайлов (docs/05 §3.2).
 *
 * Ключевая защита (паттерн 2x2, ADR-002): реальный тип файла определяется по
 * сигнатуре содержимого (magic-bytes через `file-type`), а НЕ по расширению или
 * заявленному браузером Content-Type. Несовпадение/неизвестный тип → отказ.
 */

import { fileTypeFromBuffer } from 'file-type';

/** Лимит размера файла по умолчанию: 10 МБ. */
export const MEDIA_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Белый список MIME по умолчанию (docs/05 §3.2).
 * Только растровые изображения; SVG и активные форматы запрещены.
 */
export const DEFAULT_ALLOWED_MIME: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

/** Результат валидации загрузки. */
export interface MediaValidationResult {
  ok: boolean;
  /** Реальный MIME по magic-bytes (при успехе). */
  mime?: string;
  /** Реальное расширение по magic-bytes (при успехе). */
  ext?: string;
  /** Причина отказа (при неуспехе). */
  error?: string;
}

/** Опции валидации. */
export interface ValidateUploadOptions {
  /** Разрешённые MIME-типы. По умолчанию — DEFAULT_ALLOWED_MIME. */
  allowedMime?: readonly string[];
  /** Максимальный размер в байтах. По умолчанию — MEDIA_MAX_SIZE_BYTES. */
  maxSizeBytes?: number;
}

/**
 * Проверяет загружаемый файл: размер, реальный тип по magic-bytes и
 * принадлежность к белому списку.
 *
 * @param buffer       байты файла
 * @param declaredName заявленное имя файла (только для диагностики; в решении
 *                     НЕ участвует — доверия к расширению нет)
 */
export async function validateUpload(
  buffer: Buffer,
  declaredName: string,
  opts: ValidateUploadOptions = {},
): Promise<MediaValidationResult> {
  const allowedMime = opts.allowedMime ?? DEFAULT_ALLOWED_MIME;
  const maxSizeBytes = opts.maxSizeBytes ?? MEDIA_MAX_SIZE_BYTES;

  if (buffer.length === 0) {
    return { ok: false, error: 'Пустой файл.' };
  }

  // Лимит размера — до разбора содержимого.
  if (buffer.length > maxSizeBytes) {
    return {
      ok: false,
      error:
        `Превышен лимит размера: ${buffer.length} байт ` +
        `(максимум ${maxSizeBytes}).`,
    };
  }

  // Реальный тип по magic-bytes (не по declaredName).
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    return {
      ok: false,
      error:
        `Не удалось определить тип файла по содержимому ` +
        `(magic-bytes). Имя «${declaredName}» во внимание не принимается.`,
    };
  }

  if (!allowedMime.includes(detected.mime)) {
    return {
      ok: false,
      error:
        `Недопустимый тип файла: ${detected.mime}. ` +
        `Разрешены: ${allowedMime.join(', ')}.`,
    };
  }

  return { ok: true, mime: detected.mime, ext: detected.ext };
}
