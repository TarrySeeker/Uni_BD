/**
 * Обработка изображений через sharp (docs/05 §3.2, §3.4 шаг 3).
 *
 * Генерирует основное изображение и thumbnail, читает реальные размеры.
 * Битое/не-изображение → понятная ошибка (вызывающий обрабатывает отказ).
 *
 * Защита от decompression bomb (бомба сжатия): любой вызов sharp на
 * НЕдоверенном входе ограничен числом пикселей (`limitInputPixels`) и
 * `failOn: 'warning'`. Маленький файл, разворачивающийся в гигантскую
 * картинку, отклоняется до полной аллокации памяти, а не валит процесс по OOM.
 * Дополнительно недоверенный источник декодируется РОВНО ОДИН РАЗ: из него
 * получается нормализованное (ограниченное по ширине) основное превью, а
 * thumbnail строится уже из этого безопасного буфера.
 */

import sharp from 'sharp';

/** Целевая ширина основного изображения. */
export const MAIN_MAX_WIDTH = 1600;
/** Целевая ширина thumbnail. */
export const THUMBNAIL_MAX_WIDTH = 320;

/**
 * Жёсткий лимит числа входных пикселей для sharp (защита от бомбы сжатия).
 *
 * 50 млн пикселей покрывает любые реальные фото (например 8000x6000 ≈ 48 млн),
 * но отсекает «бомбы», где маленький файл разворачивается в миллиарды пикселей
 * и вызывает OOM. sharp по умолчанию ограничивает 268 млн (0x3FFF^2) — этого
 * мало для слабого бокса, поэтому задаём явный, более консервативный предел.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Опции sharp для НЕдоверенного входа: лимит пикселей + строгий failOn. */
const UNTRUSTED_INPUT_OPTIONS = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: 'warning',
} as const;

/** Метаданные изображения. */
export interface ImageMeta {
  width: number;
  height: number;
  format: string;
}

/** Одно сгенерированное превью. */
export interface RenderedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
}

/** Результат генерации превью. */
export interface PreviewSet {
  main: RenderedImage;
  thumbnail: RenderedImage;
}

/** Опции генерации превью. */
export interface GeneratePreviewsOptions {
  /** Ширина основного изображения. */
  mainWidth?: number;
  /** Ширина thumbnail. */
  thumbnailWidth?: number;
}

/**
 * Читает реальные размеры/формат изображения.
 *
 * sharp ограничен `limitInputPixels`, поэтому изображение с числом пикселей
 * выше лимита будет отклонено ошибкой, а не приведёт к попытке аллокации.
 *
 * @throws если буфер не является валидным изображением либо превышает лимит.
 */
export async function readImageMeta(buffer: Buffer): Promise<ImageMeta> {
  let meta;
  try {
    meta = await sharp(buffer, UNTRUSTED_INPUT_OPTIONS).metadata();
  } catch (cause) {
    throw new Error('Не удалось прочитать изображение (битый файл).', {
      cause,
    });
  }
  if (!meta.width || !meta.height || !meta.format) {
    throw new Error('Изображение не содержит корректных размеров/формата.');
  }
  return { width: meta.width, height: meta.height, format: meta.format };
}

/**
 * Ресайзит уже декодированное/безопасное изображение до заданной ширины
 * (без увеличения), конвертируя в webp. Принимает опции конструктора sharp,
 * чтобы переиспользоваться как для недоверенного источника (с лимитом
 * пикселей), так и для нормализованного промежуточного буфера.
 */
async function resizeToWebp(
  buffer: Buffer,
  width: number,
  sharpOptions: sharp.SharpOptions = {},
): Promise<RenderedImage> {
  const pipeline = sharp(buffer, sharpOptions)
    .rotate() // нормализация ориентации по EXIF
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 82 });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    width: info.width,
    height: info.height,
    format: info.format,
  };
}

/**
 * Генерирует основное изображение и thumbnail.
 *
 * НЕдоверенный источник декодируется ровно один раз — с лимитом пикселей — в
 * нормализованное (ограниченное по ширине, webp) основное превью. Thumbnail
 * строится из этого уже безопасного буфера, поэтому повторного декодирования
 * исходной (потенциально «бомбовой») картинки не происходит.
 *
 * @throws если буфер не является валидным изображением либо превышает лимит.
 */
export async function generatePreviews(
  buffer: Buffer,
  opts: GeneratePreviewsOptions = {},
): Promise<PreviewSet> {
  const mainWidth = opts.mainWidth ?? MAIN_MAX_WIDTH;
  const thumbnailWidth = opts.thumbnailWidth ?? THUMBNAIL_MAX_WIDTH;

  // Единственный декод недоверенного источника — с лимитом пикселей.
  // Битое/не-изображение/«бомба» → ошибка sharp, оборачиваем понятным текстом.
  let main: RenderedImage;
  try {
    main = await resizeToWebp(buffer, mainWidth, UNTRUSTED_INPUT_OPTIONS);
  } catch (cause) {
    throw new Error('Не удалось обработать изображение (битый файл/лимит).', {
      cause,
    });
  }

  // Thumbnail из уже безопасного (ограниченного) основного буфера —
  // повторного декодирования исходника не происходит.
  const thumbnail = await resizeToWebp(main.buffer, thumbnailWidth);

  return { main, thumbnail };
}
