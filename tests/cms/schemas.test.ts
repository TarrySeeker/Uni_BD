import { describe, expect, it } from 'vitest';

import {
  CmsSectionContentSchema,
  CmsSectionInputSchema,
  CmsPageCreateSchema,
  CmsPageUpdateSchema,
} from '@/lib/cms/schemas';

/**
 * Тесты пакета 5.C-1 (docs/11 §5.1.6) — дискриминированный union CmsSectionContentSchema.
 *
 * Контракт content по type (§5.1.1); неизвестный type отвергается; чужие поля
 * отбрасываются Zod; products_grid: refine по mode + диапазон limit + дефолт 12.
 */

describe('cms/schemas — CmsSectionContentSchema (дискриминированный union)', () => {
  it('hero: валиден с title; html/imageKey/cta опциональны', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'hero',
      title: 'Заголовок',
      subtitle: 'Подзаголовок',
      html: '<p>rich</p>',
      imageKey: 'cms/hero.jpg',
      ctaLabel: 'Купить',
      ctaHref: '/catalog',
    });
    expect(r.success).toBe(true);
  });

  it('hero: без title → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'hero' });
    expect(r.success).toBe(false);
  });

  it('text: валиден с html', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'text', html: '<p>x</p>' });
    expect(r.success).toBe(true);
  });

  it('text: без html → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'text' });
    expect(r.success).toBe(false);
  });

  it('banner: валиден с imageKey; href/alt опциональны', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'banner',
      imageKey: 'cms/banner.jpg',
      href: '/sale',
      alt: 'Распродажа',
    });
    expect(r.success).toBe(true);
  });

  it('banner: без imageKey → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'banner', href: '/x' });
    expect(r.success).toBe(false);
  });

  it('faq: валиден со списком вопросов-ответов', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'faq',
      items: [{ q: 'Вопрос?', a: '<p>Ответ</p>' }],
    });
    expect(r.success).toBe(true);
  });

  it('faq: пустой items → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'faq', items: [] });
    expect(r.success).toBe(false);
  });

  it('cta: валиден с title/buttonLabel/buttonHref', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'cta',
      title: 'Готовы?',
      html: '<p>desc</p>',
      buttonLabel: 'Перейти',
      buttonHref: '/go',
    });
    expect(r.success).toBe(true);
  });

  it('cta: без buttonHref → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'cta',
      title: 'Готовы?',
      buttonLabel: 'Перейти',
    });
    expect(r.success).toBe(false);
  });

  it('gallery: валиден со списком изображений', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'gallery',
      images: [{ imageKey: 'cms/1.jpg', alt: 'a' }, { imageKey: 'cms/2.jpg' }],
    });
    expect(r.success).toBe(true);
  });

  it('gallery: пустой images → ошибка', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'gallery', images: [] });
    expect(r.success).toBe(false);
  });

  it('неизвестный type → ошибка дискриминатора', () => {
    const r = CmsSectionContentSchema.safeParse({ type: 'carousel', items: [] });
    expect(r.success).toBe(false);
  });

  it('чужие поля для типа отбрасываются (strip), результат содержит только контрактные', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'text',
      html: '<p>x</p>',
      evil: 'drop me',
      script: '<script>',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('evil');
      expect(r.data).not.toHaveProperty('script');
    }
  });
});

describe('cms/schemas — products_grid контракт', () => {
  it('mode=slugs с непустым slugs валиден, дефолт limit=12', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'slugs',
      slugs: ['krasnoe-plate', 'iphone-15'],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'products_grid') {
      expect(r.data.limit).toBe(12);
    }
  });

  it('mode=slugs с пустым slugs → ошибка (refine)', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'slugs',
      slugs: [],
    });
    expect(r.success).toBe(false);
  });

  it('mode=slugs без slugs → ошибка (refine)', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'slugs',
    });
    expect(r.success).toBe(false);
  });

  it('mode=category с categorySlug валиден', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'category',
      categorySlug: 'shoes',
      limit: 24,
    });
    expect(r.success).toBe(true);
  });

  it('mode=category без categorySlug → ошибка (refine)', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'category',
    });
    expect(r.success).toBe(false);
  });

  it('mode=brand без brandSlug → ошибка (refine)', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'brand',
    });
    expect(r.success).toBe(false);
  });

  it('mode=brand с brandSlug валиден', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'brand',
      brandSlug: 'nike',
    });
    expect(r.success).toBe(true);
  });

  it('limit вне 1..48 → ошибка', () => {
    const tooBig = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'category',
      categorySlug: 'shoes',
      limit: 49,
    });
    expect(tooBig.success).toBe(false);

    const tooSmall = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'category',
      categorySlug: 'shoes',
      limit: 0,
    });
    expect(tooSmall.success).toBe(false);
  });

  it('несуществующий slug на уровне схемы валиден (формат-строка)', () => {
    // Валидатор проверяет лишь формат — отсутствие товара обрабатывается витриной.
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'slugs',
      slugs: ['nesuschestvuyuschiy-slug-12345'],
    });
    expect(r.success).toBe(true);
  });

  it('лишние поля отброшены', () => {
    const r = CmsSectionContentSchema.safeParse({
      type: 'products_grid',
      mode: 'brand',
      brandSlug: 'nike',
      categorySlug: 'should-be-dropped',
      hacked: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('hacked');
    }
  });
});

describe('cms/schemas — секция/страница', () => {
  it('CmsSectionInputSchema: pageId/sectionKey/content валидны', () => {
    const r = CmsSectionInputSchema.safeParse({
      pageId: '11111111-1111-4111-8111-111111111111',
      sectionKey: 'intro',
      content: { type: 'text', html: '<p>x</p>' },
      displayOrder: 0,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('CmsSectionInputSchema: неверный content type → ошибка', () => {
    const r = CmsSectionInputSchema.safeParse({
      pageId: '11111111-1111-4111-8111-111111111111',
      sectionKey: 'intro',
      content: { type: 'unknown' },
    });
    expect(r.success).toBe(false);
  });

  it('CmsPageCreateSchema: title обязателен, slug опционален', () => {
    const ok = CmsPageCreateSchema.safeParse({ title: 'О компании' });
    expect(ok.success).toBe(true);

    const withSlug = CmsPageCreateSchema.safeParse({ title: 'О компании', slug: 'about' });
    expect(withSlug.success).toBe(true);

    const badSlug = CmsPageCreateSchema.safeParse({ title: 'X', slug: 'Bad Slug' });
    expect(badSlug.success).toBe(false);
  });

  it('CmsPageUpdateSchema: id обязателен, поля частичны', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Новый заголовок',
    });
    expect(r.success).toBe(true);

    const bad = CmsPageUpdateSchema.safeParse({ title: 'no id' });
    expect(bad.success).toBe(false);
  });

  it("CmsPageCreateSchema: статус только 'draft'/'archived' (публикация — через publishCmsPage)", () => {
    const ok = CmsPageCreateSchema.safeParse({ title: 'X', status: 'draft' });
    expect(ok.success).toBe(true);
    const archived = CmsPageCreateSchema.safeParse({ title: 'X', status: 'archived' });
    expect(archived.success).toBe(true);
    // 'published' через create/update запрещён (баг B волны 5).
    const published = CmsPageCreateSchema.safeParse({ title: 'X', status: 'published' });
    expect(published.success).toBe(false);
    const bad = CmsPageCreateSchema.safeParse({ title: 'X', status: 'live' });
    expect(bad.success).toBe(false);
  });
});

describe('cms/schemas — OG-текст страницы (C18)', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';

  it('CmsPageCreateSchema: принимает ogTitle/ogDescription и НЕ вырезает их (strip)', () => {
    const r = CmsPageCreateSchema.safeParse({
      title: 'О компании',
      ogTitle: 'OG заголовок',
      ogDescription: 'OG описание',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ogTitle).toBe('OG заголовок');
      expect(r.data.ogDescription).toBe('OG описание');
    }
  });

  it('CmsPageUpdateSchema: принимает ogTitle/ogDescription частично', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: UUID,
      ogTitle: 'Только OG-заголовок',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ogTitle).toBe('Только OG-заголовок');
      expect(r.data.ogDescription).toBeUndefined();
    }
  });

  it('ogTitle > 255 символов → ошибка (max как у каталога)', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: UUID,
      ogTitle: 'x'.repeat(256),
    });
    expect(r.success).toBe(false);
  });

  it('ogDescription > 1000 символов → ошибка (max как у каталога)', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: UUID,
      ogDescription: 'y'.repeat(1001),
    });
    expect(r.success).toBe(false);
  });
});
