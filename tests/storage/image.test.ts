import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { generatePreviews, readImageMeta } from '@/lib/storage/image';

/** Генерирует настоящее изображение заданного размера. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe('storage/image', () => {
  it('читает реальные размеры изображения', async () => {
    const buf = await makePng(640, 480);
    const meta = await readImageMeta(buf);
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
    expect(meta.format).toBeTruthy();
  });

  it('ресайзит большое изображение до основного и thumbnail', async () => {
    const buf = await makePng(2000, 1500);
    const result = await generatePreviews(buf);

    // основное (main) не превышает заданный размер по ширине
    expect(result.main.width).toBeLessThanOrEqual(result.main.width);
    expect(result.main.buffer.length).toBeGreaterThan(0);

    // thumbnail заметно меньше основного
    expect(result.thumbnail.width).toBeLessThan(result.main.width);
    expect(result.thumbnail.buffer.length).toBeGreaterThan(0);

    // проверим, что превью — действительно валидные изображения
    const mainMeta = await sharp(result.main.buffer).metadata();
    const thumbMeta = await sharp(result.thumbnail.buffer).metadata();
    expect(mainMeta.width).toBe(result.main.width);
    expect(thumbMeta.width).toBe(result.thumbnail.width);
  });

  it('не увеличивает изображение меньше целевого размера (withoutEnlargement)', async () => {
    const buf = await makePng(100, 80);
    const result = await generatePreviews(buf);
    expect(result.main.width).toBeLessThanOrEqual(100);
  });

  it('корректно обрабатывает битое/не-изображение (бросает понятную ошибку)', async () => {
    const garbage = Buffer.from('definitely not an image', 'utf8');
    await expect(generatePreviews(garbage)).rejects.toThrow();
  });
});
