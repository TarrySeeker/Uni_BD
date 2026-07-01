import { describe, expect, it } from 'vitest';

import { cleanLogoUrl } from '@/lib/config/settings';

/**
 * Фикс ревью Batch 6: read-side очистки логотипа. Относительный путь от «/» (так
 * отдаёт локальное хранилище: '/media/…') теперь проходит как есть — раньше
 * `new URL()` бросал на относительном пути → логотип, загруженный в local-режиме,
 * никогда не рендерился. Плейсхолдер example.com и мусор по-прежнему → null.
 */
describe('cleanLogoUrl', () => {
  it('относительный путь локального хранилища проходит как есть', () => {
    expect(cleanLogoUrl('/media/settings/logo/abc.webp')).toBe('/media/settings/logo/abc.webp');
  });

  it('абсолютный валидный URL проходит', () => {
    expect(cleanLogoUrl('https://cdn.example/logo.svg')).toBe('https://cdn.example/logo.svg');
  });

  it('плейсхолдер example.com → null (битая картинка из .env.example)', () => {
    expect(cleanLogoUrl('https://example.com/logo.svg')).toBeNull();
    expect(cleanLogoUrl('https://www.example.com/logo.svg')).toBeNull();
  });

  it('пустое/мусор/невалидный URL → null', () => {
    expect(cleanLogoUrl('')).toBeNull();
    expect(cleanLogoUrl('   ')).toBeNull();
    expect(cleanLogoUrl('не url')).toBeNull();
    expect(cleanLogoUrl(null)).toBeNull();
    expect(cleanLogoUrl(undefined)).toBeNull();
  });
});
