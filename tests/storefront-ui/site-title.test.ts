import { describe, expect, it } from 'vitest';

import { siteTitle, pageTitle } from '../../storefront/lib/seo';
import type { PublicSettingsDto } from '../../storefront/lib/types';

// ЮНИТ: заголовки страниц берутся ИЗ АДМИНКИ (settings.seo), а не из хардкода.
// На проде <title> главной — длинная SEO-фраза из БД (thread.seo_title), а не имя
// магазина. Витрина обязана уметь то же: владелец меняет title в админке без правки
// кода. titleTemplate — шаблон с '%s' под заголовок страницы (Next-совместимый).
function settings(seo: Partial<PublicSettingsDto['seo']>): PublicSettingsDto {
  return {
    seo: {
      siteName: null,
      siteUrl: null,
      titleTemplate: '%s',
      defaultDescription: null,
      twitterSite: null,
      ...seo,
    },
  } as PublicSettingsDto;
}

describe('siteTitle — заголовок сайта (главная)', () => {
  it('берёт siteName из админки', () => {
    expect(siteTitle(settings({ siteName: 'Carre-Russe' }))).toBe('Carre-Russe');
  });

  it('SEO-фраза прода целиком помещается в siteName', () => {
    const prod = 'Carré Russe — платки, банданы, шарфы и твилли с принтами русской культуры и традиции';
    expect(siteTitle(settings({ siteName: prod }))).toBe(prod);
  });

  it('нет настроек → пустая строка, а не чужой хардкод', () => {
    expect(siteTitle(null)).toBe('');
    expect(siteTitle(settings({ siteName: null }))).toBe('');
  });
});

describe('pageTitle — заголовок внутренней страницы', () => {
  it('подставляет заголовок в titleTemplate из админки', () => {
    const s = settings({ siteName: 'Carre-Russe', titleTemplate: '%s | Carre Russe' });
    expect(pageTitle('Каталог', s)).toBe('Каталог | Carre Russe');
  });

  it('шаблон по умолчанию "%s" → только заголовок страницы', () => {
    const s = settings({ siteName: 'Carre-Russe' });
    expect(pageTitle('Каталог', s)).toBe('Каталог');
  });

  it('шаблон без %s → используется как есть + заголовок не теряется', () => {
    const s = settings({ siteName: 'Carre-Russe', titleTemplate: 'сломанный шаблон' });
    expect(pageTitle('Каталог', s)).toBe('Каталог');
  });

  it('нет настроек → отдаёт заголовок страницы без обвязки', () => {
    expect(pageTitle('Каталог', null)).toBe('Каталог');
  });

  it('пустой заголовок страницы → падает на siteTitle', () => {
    const s = settings({ siteName: 'Carre-Russe', titleTemplate: '%s | Carre Russe' });
    expect(pageTitle('', s)).toBe('Carre-Russe');
  });
});
