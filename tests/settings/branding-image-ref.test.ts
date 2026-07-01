import { describe, expect, it } from 'vitest';

import { brandingSchema } from '@/lib/settings/schemas';

/**
 * Фикс ревью Batch 6: логотип/favicon настроек должны приниматься и как абсолютный
 * URL, и как относительный путь от «/». Локальное хранилище по умолчанию (без S3)
 * отдаёт относительный '/media/settings/logo/<uuid>.webp'; раньше схема требовала
 * .url() (только абсолютный), поэтому после загрузки логотипа форма брендинга
 * переставала сохраняться. Опасный 'javascript:' и пустая строка отсекаются.
 */
describe('brandingSchema — logoUrl/faviconUrl принимают URL и относительный путь', () => {
  it('относительный путь локального хранилища валиден', () => {
    const r = brandingSchema.safeParse({ logoUrl: '/media/settings/logo/abc.webp' });
    expect(r.success).toBe(true);
  });

  it('абсолютный http(s)-URL валиден', () => {
    const r = brandingSchema.safeParse({
      logoUrl: 'https://cdn.example/logo.svg',
      faviconUrl: 'https://cdn.example/fav.png',
    });
    expect(r.success).toBe(true);
  });

  it('относительный favicon валиден', () => {
    expect(brandingSchema.safeParse({ faviconUrl: '/media/settings/favicon/x.webp' }).success).toBe(
      true,
    );
  });

  it('javascript:-схема отклоняется (безопасность)', () => {
    expect(brandingSchema.safeParse({ logoUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('без протокола и без «/» (опечатка) отклоняется', () => {
    expect(brandingSchema.safeParse({ logoUrl: 'cdn.example/logo.svg' }).success).toBe(false);
  });

  it('logo/favicon опциональны (поле можно не задавать)', () => {
    expect(brandingSchema.safeParse({ shopName: 'Магазин' }).success).toBe(true);
  });
});
