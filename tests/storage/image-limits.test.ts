/**
 * Защита от decompression bomb (бомба сжатия) в обработке изображений.
 *
 * Маленький файл может декодироваться в гигантскую картинку (миллиарды
 * пикселей) → усиление памяти и OOM. sharp обязан вызываться с явным
 * `limitInputPixels`, а источник должен декодироваться один раз.
 *
 * Часть тестов — реальный прогон sharp (он установлен и используется в проде),
 * часть — через мок sharp, чтобы зафиксировать опции конструктора.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  generatePreviews,
  readImageMeta,
  MAX_INPUT_PIXELS,
} from '@/lib/storage/image';

/** Генерирует настоящее изображение заданного размера и формата. */
async function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .webp()
    .toBuffer();
}

describe('storage/image — лимит пикселей (decompression bomb)', () => {
  it('экспортирует разумный лимит входных пикселей', () => {
    expect(typeof MAX_INPUT_PIXELS).toBe('number');
    expect(MAX_INPUT_PIXELS).toBeGreaterThan(0);
    // лимит должен покрывать реальные фото, но не «бомбу»
    expect(MAX_INPUT_PIXELS).toBeLessThanOrEqual(200_000_000);
  });

  it('нормальное фото 800x600 webp проходит как раньше (readImageMeta)', async () => {
    const buf = await makeWebp(800, 600);
    const meta = await readImageMeta(buf);
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe('webp');
  });

  it('нормальное фото 800x600 webp проходит как раньше (generatePreviews)', async () => {
    const buf = await makeWebp(800, 600);
    const result = await generatePreviews(buf);
    expect(result.main.width).toBeLessThanOrEqual(800);
    expect(result.main.format).toBe('webp');
    expect(result.thumbnail.width).toBeLessThan(result.main.width);
  });

  it(
    'изображение с числом пикселей выше лимита отклоняется (реальный sharp)',
    async () => {
      // Размеры чуть больше лимита: width*height > MAX_INPUT_PIXELS.
      // sharp бросает "Input image exceeds pixel limit" при декоде, не
      // аллоцируя всю картинку. Создание тестовой «бомбы» (энкод ~50М
      // пикселей) само по себе небыстрое — отсюда повышенный таймаут.
      const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 50;
      const bomb = await makeWebp(side, side);
      expect(side * side).toBeGreaterThan(MAX_INPUT_PIXELS);
      await expect(readImageMeta(bomb)).rejects.toThrow();
      await expect(generatePreviews(bomb)).rejects.toThrow();
    },
    20_000,
  );
});

describe('storage/image — sharp вызывается с limitInputPixels (мок)', () => {
  it('readImageMeta передаёт limitInputPixels в sharp', async () => {
    vi.resetModules();
    const meta = { width: 10, height: 10, format: 'webp' };

    const sharpMock = vi.fn((..._args: unknown[]) => ({
      metadata: vi.fn().mockResolvedValue(meta),
    }));
    vi.doMock('sharp', () => ({ default: sharpMock }));
    const { readImageMeta: readMeta } = await import('@/lib/storage/image');

    await readMeta(Buffer.from('x'));

    expect(sharpMock).toHaveBeenCalled();
    const opts = sharpMock.mock.calls[0]?.[1] as
      | { limitInputPixels?: number }
      | undefined;
    expect(opts?.limitInputPixels).toBe(MAX_INPUT_PIXELS);

    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('generatePreviews декодирует НЕдоверенный исходник ровно один раз с лимитом', async () => {
    vi.resetModules();

    const source = Buffer.from('SOURCE-UNTRUSTED');
    const renderedBuf = await makeWebp(50, 40);

    // Каждый вызов sharp() возвращает свой pipeline; toBuffer отдаёт
    // нормализованный (ограниченный) буфер.
    const intermediate = Buffer.from('NORMALIZED-INTERMEDIATE');
    const makePipeline = () => ({
      rotate: vi.fn().mockReturnThis(),
      resize: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      png: vi.fn().mockReturnThis(),
      metadata: vi
        .fn()
        .mockResolvedValue({ width: 800, height: 600, format: 'webp' }),
      toBuffer: vi.fn(async (arg?: { resolveWithObject?: boolean }) => {
        if (arg?.resolveWithObject) {
          return {
            data: renderedBuf,
            info: { width: 800, height: 600, format: 'webp' },
          };
        }
        return intermediate;
      }),
    });
    const sharpMock = vi.fn((..._args: unknown[]) => makePipeline());
    vi.doMock('sharp', () => ({ default: sharpMock }));

    const { generatePreviews: genPreviews } = await import(
      '@/lib/storage/image'
    );

    await genPreviews(source);

    // Найти все вызовы, где первым аргументом был именно недоверенный source.
    const sourceCalls = sharpMock.mock.calls.filter((c) => c[0] === source);
    expect(sourceCalls).toHaveLength(1);

    // Этот единственный декод исходника — с лимитом пикселей.
    const opts = sourceCalls[0]?.[1] as
      | { limitInputPixels?: number }
      | undefined;
    expect(opts?.limitInputPixels).toBe(MAX_INPUT_PIXELS);

    vi.doUnmock('sharp');
    vi.resetModules();
  });
});
