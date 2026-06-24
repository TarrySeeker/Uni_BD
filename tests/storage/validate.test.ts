import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  validateUpload,
  MEDIA_MAX_SIZE_BYTES,
  DEFAULT_ALLOWED_MIME,
} from '@/lib/storage/validate';

/** Генерирует настоящий PNG-буфер заданного размера через sharp. */
async function makePng(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
}

describe('storage/validate', () => {
  it('пропускает настоящий PNG (magic-bytes совпали, тип в белом списке)', async () => {
    const png = await makePng();
    const res = await validateUpload(png, 'photo.png');
    expect(res.ok).toBe(true);
    expect(res.mime).toBe('image/png');
    expect(res.ext).toBe('png');
    expect(res.error).toBeUndefined();
  });

  it('пропускает настоящий WEBP', async () => {
    const webp = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer();
    const res = await validateUpload(webp, 'photo.webp');
    expect(res.ok).toBe(true);
    expect(res.mime).toBe('image/webp');
  });

  it('отклоняет файл с расширением .png, но содержимым не-картинки (magic-bytes)', async () => {
    const fake = Buffer.from('this is plain text, not an image at all', 'utf8');
    const res = await validateUpload(fake, 'evil.png');
    expect(res.ok).toBe(false);
    expect(res.mime).toBeUndefined();
    expect(res.error).toBeTruthy();
  });

  it('отклоняет превышение лимита размера', async () => {
    const png = await makePng();
    const oversize = Buffer.concat([
      png,
      Buffer.alloc(MEDIA_MAX_SIZE_BYTES + 1),
    ]);
    const res = await validateUpload(oversize, 'big.png');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/размер|size|лимит/i);
  });

  it('отклоняет запрещённый тип (например GIF) при белом списке по умолчанию', async () => {
    // Минимальный валидный GIF89a заголовок + тело.
    const gif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
    const res = await validateUpload(gif, 'anim.gif');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('уважает кастомный белый список через опции', async () => {
    const png = await makePng();
    const res = await validateUpload(png, 'photo.png', {
      allowedMime: ['image/webp'],
    });
    expect(res.ok).toBe(false);
  });

  it('экспортирует дефолтный белый список и лимит', () => {
    expect(DEFAULT_ALLOWED_MIME).toContain('image/png');
    expect(DEFAULT_ALLOWED_MIME).toContain('image/jpeg');
    expect(DEFAULT_ALLOWED_MIME).toContain('image/webp');
    expect(DEFAULT_ALLOWED_MIME).toContain('image/avif');
    expect(MEDIA_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
});
