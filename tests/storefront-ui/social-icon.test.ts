import { describe, expect, it } from 'vitest';

import { socialIcon } from '../../storefront/lib/social';

// ЮНИТ: тип соцсети из админки → путь к SVG-иконке (порт мэппинга footer_new.twig).
// Иконки реально лежат в storefront/public/images/social: facebook/instagram/youtube/pin.
describe('socialIcon', () => {
  it('известные типы → иконка из /images/social', () => {
    expect(socialIcon('facebook')).toBe('/images/social/facebook.svg');
    expect(socialIcon('instagram')).toBe('/images/social/instagram.svg');
    expect(socialIcon('youtube')).toBe('/images/social/youtube.svg');
    expect(socialIcon('pinterest')).toBe('/images/social/pin.svg');
  });

  it('легаси-алиасы прода (fb/inst/vimeo/od) → те же иконки', () => {
    expect(socialIcon('fb')).toBe('/images/social/facebook.svg');
    expect(socialIcon('inst')).toBe('/images/social/instagram.svg');
    expect(socialIcon('vimeo')).toBe('/images/social/youtube.svg');
    expect(socialIcon('od')).toBe('/images/social/pin.svg');
  });

  it('регистр и пробелы не важны', () => {
    expect(socialIcon('  Facebook ')).toBe('/images/social/facebook.svg');
    expect(socialIcon('INSTAGRAM')).toBe('/images/social/instagram.svg');
  });

  it('неизвестный тип → null (витрина покажет текст-фолбэк)', () => {
    expect(socialIcon('telegram')).toBeNull();
    expect(socialIcon('')).toBeNull();
  });
});
