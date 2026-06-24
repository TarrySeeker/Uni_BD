import { describe, expect, it } from 'vitest';

import { sanitizeSectionContent } from '@/lib/cms/sanitize-section';
import type { CmsSectionContent } from '@/lib/cms/types';

/**
 * ЮНИТ (без БД): серверная санитизация rich-text внутри content секции —
 * обязательный анти-XSS инвариант (доверие клиенту запрещено, аналог anti-tamper
 * расчёта цен). upsertCmsSection вызывает sanitizeSectionContent ПЕРЕД записью.
 *
 * Проверяем: script-тег, on*-обработчики и javascript:-схема вырезаются у
 * text/hero/faq/cta; разрешённая разметка сохраняется; не-rich-text типы
 * (banner/products_grid/gallery) проходят без изменений; вход иммутабелен.
 */

describe('sanitizeSectionContent — анти-XSS rich-text секций', () => {
  it('text: <script> вырезается, текст/разметка сохраняются (HTML с <script> сохраняется очищенным)', () => {
    const input: CmsSectionContent = {
      type: 'text',
      html: '<p>Привет <strong>мир</strong></p><script>alert(1)</script>',
    };
    const out = sanitizeSectionContent(input) as { type: 'text'; html: string };
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('alert(1)');
    expect(out.html).toContain('<p>');
    expect(out.html).toContain('<strong>мир</strong>');
  });

  it('text: on*-обработчик и javascript:-href вырезаются', () => {
    const input: CmsSectionContent = {
      type: 'text',
      html: '<p onclick="steal()">x</p><a href="javascript:alert(1)">link</a>',
    };
    const out = sanitizeSectionContent(input) as { type: 'text'; html: string };
    expect(out.html).not.toContain('onclick');
    expect(out.html.toLowerCase()).not.toContain('javascript:');
  });

  it('hero: html санитизируется (script вырезан), прочие поля сохранены', () => {
    const input: CmsSectionContent = {
      type: 'hero',
      title: 'Заголовок',
      html: '<p>ok</p><script>bad()</script>',
      ctaHref: '/catalog',
    };
    const out = sanitizeSectionContent(input) as {
      type: 'hero';
      title: string;
      html?: string;
      ctaHref?: string;
    };
    expect(out.title).toBe('Заголовок');
    expect(out.ctaHref).toBe('/catalog');
    expect(out.html).not.toContain('<script');
  });

  it('faq: rich-text ответов санитизируется, вопросы целы', () => {
    const input: CmsSectionContent = {
      type: 'faq',
      items: [{ q: 'Вопрос?', a: '<em>да</em><script>x()</script>' }],
    };
    const out = sanitizeSectionContent(input) as {
      type: 'faq';
      items: { q: string; a: string }[];
    };
    expect(out.items[0]!.q).toBe('Вопрос?');
    expect(out.items[0]!.a).toContain('<em>да</em>');
    expect(out.items[0]!.a).not.toContain('<script');
  });

  it('cta: html санитизируется', () => {
    const input: CmsSectionContent = {
      type: 'cta',
      title: 'Купить',
      html: '<p>now</p><script>x()</script>',
      buttonLabel: 'Купить',
      buttonHref: '/checkout',
    };
    const out = sanitizeSectionContent(input) as { type: 'cta'; html?: string };
    expect(out.html).not.toContain('<script');
  });

  it('banner/products_grid/gallery — без rich-text, проходят без искажений', () => {
    const banner: CmsSectionContent = {
      type: 'banner',
      imageKey: 'banners/a.webp',
      href: '/sale',
    };
    expect(sanitizeSectionContent(banner)).toEqual(banner);

    const grid: CmsSectionContent = {
      type: 'products_grid',
      mode: 'slugs',
      slugs: ['p-1', 'p-2'],
      limit: 12,
    };
    expect(sanitizeSectionContent(grid)).toEqual(grid);
  });

  it('не мутирует входной объект (возвращает новый)', () => {
    const input: CmsSectionContent = {
      type: 'text',
      html: '<p>x</p><script>y()</script>',
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeSectionContent(input);
    expect(input).toEqual(snapshot);
  });
});
