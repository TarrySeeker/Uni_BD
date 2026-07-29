import { describe, expect, it } from 'vitest';

import { CmsPageCreateSchema, CmsPageUpdateSchema } from '@/lib/cms/schemas';
import { mapCmsPage } from '@/lib/cms/repository';
import { toPublicPageListItemDto } from '@/lib/storefront/cms-dto';
import type { SeoCtx } from '@/lib/seo/meta';
import type { CmsPage } from '@/lib/cms/types';

/**
 * Признак CMS-страницы «показывать в боковом меню разделов» (show_in_nav) и её
 * позиция в этом меню (nav_order) — АДДИТИВНОЕ поле волны «доп-страницы».
 *
 * ЗАЧЕМ. Боковое меню доп-страниц (эталон carrerusse.com `.about__nav`) обязано
 * строиться ИЗ ДАННЫХ, а не из списка в коде витрины: на carre это about/delivery/
 * payment/policy/offer, у следующего магазина — что-то другое или ничего. Флаг у
 * страницы — самое дешёвое из решений: не требует новой сущности «меню», живёт
 * там же, где title/slug/SEO, и редактируется в той же карточке страницы.
 *
 * ОБРАТНАЯ СОВМЕСТИМОСТЬ. show_in_nav — NOT NULL DEFAULT false: существующие
 * страницы остаются вне боковика, пока владелец не отметит их сам. nav_order —
 * nullable: «порядок не задан» ≠ 0.
 */

function makeSeoCtx(): SeoCtx {
  return {
    siteUrl: 'https://shop.example',
    titleTemplate: '%s',
    siteName: 'Магазин',
    defaultDescription: null,
    defaultOgImageKey: null,
    publicUrl: (k) => k,
    pathPrefix: 'page',
  };
}

function domainPage(over: Partial<CmsPage> = {}): CmsPage {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'p-1',
    slug: 'about',
    title: 'О компании',
    status: 'published',
    publishedAt: now,
    seoTitle: null,
    seoDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageUrl: null,
    canonicalUrl: null,
    noindex: false,
    sitemapPriority: null,
    sitemapChangefreq: null,
    showInNav: false,
    navOrder: null,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('Zod-схемы CMS-страницы принимают признак бокового меню', () => {
  it('create: showInNav/navOrder опциональны (старые вызовы не ломаются)', () => {
    const ok = CmsPageCreateSchema.safeParse({ title: 'О нас' });
    expect(ok.success).toBe(true);
  });

  it('create: принимает showInNav=true и целочисленный navOrder', () => {
    const r = CmsPageCreateSchema.safeParse({
      title: 'Доставка',
      showInNav: true,
      navOrder: 20,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.showInNav).toBe(true);
    expect(r.success && r.data.navOrder).toBe(20);
  });

  it('update: те же поля частично', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      showInNav: false,
    });
    expect(r.success).toBe(true);
  });

  it('navOrder обязан быть целым (дробная позиция — ошибка ввода)', () => {
    const r = CmsPageCreateSchema.safeParse({ title: 'X', navOrder: 1.5 });
    expect(r.success).toBe(false);
  });

  it('navOrder=0 валиден (первая позиция), не путается с «не задан»', () => {
    const r = CmsPageCreateSchema.safeParse({ title: 'X', navOrder: 0 });
    expect(r.success).toBe(true);
    expect(r.success && r.data.navOrder).toBe(0);
  });
});

describe('mapCmsPage — строка БД → домен', () => {
  it('читает show_in_nav/nav_order', () => {
    const p = mapCmsPage({
      id: 'p',
      slug: 's',
      title: 't',
      status: 'published',
      published_at: null,
      noindex: false,
      show_in_nav: true,
      nav_order: 10,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(p.showInNav).toBe(true);
    expect(p.navOrder).toBe(10);
  });

  it('строка до миграции (колонок нет) → false/null, без падения', () => {
    const p = mapCmsPage({
      id: 'p',
      slug: 's',
      title: 't',
      status: 'draft',
      published_at: null,
      noindex: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(p.showInNav).toBe(false);
    expect(p.navOrder).toBeNull();
  });

  it('nav_order=0 из БД остаётся нулём, а не превращается в null', () => {
    const p = mapCmsPage({
      id: 'p',
      slug: 's',
      title: 't',
      status: 'draft',
      published_at: null,
      noindex: false,
      nav_order: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(p.navOrder).toBe(0);
  });
});

describe('toPublicPageListItemDto — витрина получает признак боковика', () => {
  it('отдаёт showInNav/navOrder (это и есть источник пунктов меню)', () => {
    const dto = toPublicPageListItemDto(
      domainPage({ showInNav: true, navOrder: 5 }),
      makeSeoCtx(),
    );
    expect(dto.showInNav).toBe(true);
    expect(dto.navOrder).toBe(5);
  });

  it('НЕ протекают служебные поля (id/status/audit) — контракт публичного DTO', () => {
    const dto = toPublicPageListItemDto(domainPage({ showInNav: true }), makeSeoCtx());
    expect(Object.keys(dto).sort()).toEqual(
      ['meta', 'navOrder', 'showInNav', 'slug', 'title'].sort(),
    );
  });
});
