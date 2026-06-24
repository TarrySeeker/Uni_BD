/**
 * Тесты чистых хелперов формы редактора секций CMS (docs/11 §5.1.5/§5.1.6,
 * пакет 5.C-3).
 *
 * Редактор секций — client-компонент, его браузерное e2e вынесено в Playwright
 * (tests:e2e, вне обязательного vitest). Здесь — логическое ядро редактора без
 * браузера: маппинг `type → набор полей` (что рисовать) и `flat form state →
 * типизированный content` (валидируется тем же CmsSectionContentSchema, что и
 * сервер). Это load-bearing-логика формы; чистая, тестируемая в node-окружении.
 */

import { describe, it, expect } from 'vitest';

import {
  SECTION_FIELD_SPECS,
  emptyFormStateFor,
  buildSectionContent,
  SECTION_TYPE_LABELS,
  type SectionFormState,
} from '@/lib/cms/section-form';
import { CMS_SECTION_TYPES } from '@/lib/cms/types';
import { CmsSectionContentSchema } from '@/lib/cms/schemas';

describe('SECTION_FIELD_SPECS — маппинг type → поля', () => {
  it('покрывает все 7 типов секций без пропусков', () => {
    for (const type of CMS_SECTION_TYPES) {
      expect(SECTION_FIELD_SPECS[type]).toBeDefined();
    }
    expect(Object.keys(SECTION_FIELD_SPECS).sort()).toEqual(
      [...CMS_SECTION_TYPES].sort(),
    );
  });

  it('каждый тип имеет человекочитаемую подпись', () => {
    for (const type of CMS_SECTION_TYPES) {
      expect(typeof SECTION_TYPE_LABELS[type]).toBe('string');
      expect(SECTION_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });

  it('text имеет ровно одно rich-text поле html', () => {
    const fields = SECTION_FIELD_SPECS.text;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.name).toBe('html');
    expect(fields[0]!.kind).toBe('richtext');
  });

  it('hero содержит richtext-поле html и поля заголовка/cta', () => {
    const names = SECTION_FIELD_SPECS.hero.map((f) => f.name);
    expect(names).toContain('title');
    expect(names).toContain('html');
    expect(names).toContain('ctaLabel');
    expect(names).toContain('ctaHref');
    const html = SECTION_FIELD_SPECS.hero.find((f) => f.name === 'html');
    expect(html?.kind).toBe('richtext');
  });

  it('products_grid содержит селектор mode и поля-идентификаторы', () => {
    const fields = SECTION_FIELD_SPECS.products_grid;
    const mode = fields.find((f) => f.name === 'mode');
    expect(mode?.kind).toBe('select');
    const names = fields.map((f) => f.name);
    expect(names).toContain('slugs');
    expect(names).toContain('categorySlug');
    expect(names).toContain('brandSlug');
    expect(names).toContain('limit');
  });

  it('banner/gallery не содержат rich-text полей (нет HTML для санитизации)', () => {
    for (const type of ['banner', 'gallery'] as const) {
      const hasRich = SECTION_FIELD_SPECS[type].some((f) => f.kind === 'richtext');
      expect(hasRich).toBe(false);
    }
  });

  it("поля imageKey hero/banner получают kind='image' (загрузчик вместо ручного ключа)", () => {
    const heroImg = SECTION_FIELD_SPECS.hero.find((f) => f.name === 'imageKey');
    expect(heroImg?.kind).toBe('image');
    const bannerImg = SECTION_FIELD_SPECS.banner.find((f) => f.name === 'imageKey');
    expect(bannerImg?.kind).toBe('image');
  });

  it("gallery.images получает kind='image' (мультизагрузка ключей)", () => {
    const galleryImgs = SECTION_FIELD_SPECS.gallery.find((f) => f.name === 'images');
    expect(galleryImgs?.kind).toBe('image');
  });

  it("buildSectionContent совместим с kind='image' (ключ собирается как раньше)", () => {
    // 'image' — лишь UI-контрол; сборка content идёт по name, не по kind (фолбэк
    // ручного ввода ключа сохранён). banner с imageKey по-прежнему валиден.
    const ok = buildSectionContent({
      type: 'banner',
      imageKey: 'cms/uploaded.webp',
      href: '',
      alt: '',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.content).toMatchObject({ type: 'banner', imageKey: 'cms/uploaded.webp' });
  });
});

describe('emptyFormStateFor — стартовое состояние формы по type', () => {
  it('инициализирует все поля типа', () => {
    const state = emptyFormStateFor('hero');
    expect(state.type).toBe('hero');
    expect(state).toHaveProperty('title');
    expect(state).toHaveProperty('html');
  });

  it('products_grid получает дефолтный mode=slugs и limit=12', () => {
    const state = emptyFormStateFor('products_grid');
    expect(state.mode).toBe('slugs');
    expect(state.limit).toBe('12');
  });
});

describe('buildSectionContent — flat form state → типизированный content', () => {
  it('text: html → { type:text, html } и проходит CmsSectionContentSchema', () => {
    const state: SectionFormState = { type: 'text', html: '<p>Привет</p>' };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual({ type: 'text', html: '<p>Привет</p>' });
      expect(CmsSectionContentSchema.safeParse(result.content).success).toBe(true);
    }
  });

  it('hero: пустые опциональные поля отбрасываются', () => {
    const state: SectionFormState = {
      type: 'hero',
      title: 'Заголовок',
      subtitle: '',
      html: '',
      imageKey: '',
      ctaLabel: '',
      ctaHref: '',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual({ type: 'hero', title: 'Заголовок' });
    }
  });

  it('products_grid mode=slugs: строка слагов → массив', () => {
    const state: SectionFormState = {
      type: 'products_grid',
      mode: 'slugs',
      slugs: 'phone-1, phone-2 ,phone-3',
      categorySlug: '',
      brandSlug: '',
      limit: '8',
      title: '',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toMatchObject({
        type: 'products_grid',
        mode: 'slugs',
        slugs: ['phone-1', 'phone-2', 'phone-3'],
        limit: 8,
      });
    }
  });

  it('products_grid mode=category: берёт categorySlug, игнорирует slugs', () => {
    const state: SectionFormState = {
      type: 'products_grid',
      mode: 'category',
      slugs: '',
      categorySlug: 'smartphones',
      brandSlug: '',
      limit: '12',
      title: 'Смартфоны',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toMatchObject({
        type: 'products_grid',
        mode: 'category',
        categorySlug: 'smartphones',
        title: 'Смартфоны',
      });
      expect('slugs' in result.content).toBe(false);
    }
  });

  it('products_grid mode=slugs с пустым списком → ошибка валидации (refine схемы)', () => {
    const state: SectionFormState = {
      type: 'products_grid',
      mode: 'slugs',
      slugs: '',
      categorySlug: '',
      brandSlug: '',
      limit: '12',
      title: '',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors).length).toBeGreaterThan(0);
    }
  });

  it('faq: парсит multiline q|a в items', () => {
    const state: SectionFormState = {
      type: 'faq',
      items: 'Вопрос 1|Ответ 1\nВопрос 2|<b>Ответ 2</b>',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual({
        type: 'faq',
        items: [
          { q: 'Вопрос 1', a: 'Ответ 1' },
          { q: 'Вопрос 2', a: '<b>Ответ 2</b>' },
        ],
      });
    }
  });

  it('gallery: парсит multiline imageKey|alt в images', () => {
    const state: SectionFormState = {
      type: 'gallery',
      images: 'media/a.webp|Фото A\nmedia/b.webp',
    };
    const result = buildSectionContent(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual({
        type: 'gallery',
        images: [
          { imageKey: 'media/a.webp', alt: 'Фото A' },
          { imageKey: 'media/b.webp' },
        ],
      });
    }
  });

  it('cta: обязательные buttonLabel/buttonHref; пустой buttonHref → ошибка', () => {
    const ok = buildSectionContent({
      type: 'cta',
      title: 'Купить',
      html: '',
      buttonLabel: 'В корзину',
      buttonHref: '/cart',
    });
    expect(ok.ok).toBe(true);

    const bad = buildSectionContent({
      type: 'cta',
      title: 'Купить',
      html: '',
      buttonLabel: 'В корзину',
      buttonHref: '',
    });
    expect(bad.ok).toBe(false);
  });

  it('banner: imageKey обязателен; пустой → ошибка', () => {
    const bad = buildSectionContent({
      type: 'banner',
      imageKey: '',
      href: '',
      alt: '',
    });
    expect(bad.ok).toBe(false);

    const ok = buildSectionContent({
      type: 'banner',
      imageKey: 'banners/sale.webp',
      href: '/sale',
      alt: 'Распродажа',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.content).toEqual({
        type: 'banner',
        imageKey: 'banners/sale.webp',
        href: '/sale',
        alt: 'Распродажа',
      });
    }
  });

  it('контент любого валидного состояния проходит CmsSectionContentSchema (анти-дрейф)', () => {
    const states: SectionFormState[] = [
      { type: 'text', html: '<p>x</p>' },
      { type: 'hero', title: 'H' },
      { type: 'banner', imageKey: 'b/x.webp' },
      {
        type: 'products_grid',
        mode: 'brand',
        slugs: '',
        categorySlug: '',
        brandSlug: 'apple',
        limit: '6',
        title: '',
      },
      { type: 'faq', items: 'q|a' },
      { type: 'cta', title: 'T', buttonLabel: 'L', buttonHref: '/h' },
      { type: 'gallery', images: 'g/x.webp|alt' },
    ];
    for (const state of states) {
      const result = buildSectionContent(state);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(CmsSectionContentSchema.safeParse(result.content).success).toBe(true);
      }
    }
  });
});
