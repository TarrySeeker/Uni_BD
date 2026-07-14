import { describe, expect, it } from 'vitest';

import {
  toPublicNewsListDto,
  toPublicNewsDetailDto,
} from '@/lib/storefront/news-dto';
import type { LocalizeCtx } from '@/lib/storefront/locale';
import type { NewsArticle, NewsListRow } from '@/lib/news/types';
import type { SeoCtx } from '@/lib/seo/meta';

/**
 * ЮНИТ (без БД/Next): публичные DTO новостей (docs/24 §3, ADR-i18n §1).
 * Инвариант: ФОРМА DTO не меняется между locale — меняются только ЗНАЧЕНИЯ
 * переводимых полей; служебные поля (id/status/timestamps/сырые S3-ключи) скрыты.
 */

const EN: LocalizeCtx = { locale: 'en', defaultLocale: 'ru' };
const FR: LocalizeCtx = { locale: 'fr', defaultLocale: 'ru' };
const RU: LocalizeCtx = { locale: 'ru', defaultLocale: 'ru' };
const PUB = (k: string) => `https://cdn.test/${k}`;

const SEO: SeoCtx = {
  siteUrl: 'https://shop.test',
  titleTemplate: '%s',
  siteName: 'Shop',
  defaultDescription: null,
  defaultOgImageKey: null,
  publicUrl: PUB,
  pathPrefix: 'news',
};

const D = new Date('2026-07-01T00:00:00Z');

function article(over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'n1',
    slug: 'welcome',
    title: 'Привет',
    groupLabel: 'Анонсы',
    excerpt: 'Краткий анонс',
    body: '<p>Тело</p>',
    coverImageKey: 'news/cover.webp',
    status: 'published',
    publishedAt: D,
    sortOrder: 0,
    seoTitle: null,
    seoDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    noindex: false,
    canonicalUrl: null,
    translations: { en: { title: 'Hello', body: '<p>Body</p>' } },
    createdBy: null,
    updatedBy: null,
    createdAt: D,
    updatedAt: D,
    ...over,
  };
}

function listRow(over: Partial<NewsListRow> = {}): NewsListRow {
  return {
    id: 'n1',
    slug: 'welcome',
    title: 'Привет',
    groupLabel: 'Анонсы',
    excerpt: 'Краткий анонс',
    coverImageKey: 'news/cover.webp',
    status: 'published',
    publishedAt: D,
    sortOrder: 0,
    seoTitle: null,
    seoDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    noindex: false,
    canonicalUrl: null,
    translations: { en: { title: 'Hello', excerpt: 'Short teaser' } },
    updatedAt: D,
    ...over,
  };
}

describe('news-dto — лента (list)', () => {
  it('locale=en → переведённые title/excerpt; форма DTO неизменна', () => {
    const ru = toPublicNewsListDto(listRow(), PUB, RU);
    const en = toPublicNewsListDto(listRow(), PUB, EN);
    expect(ru.title).toBe('Привет');
    expect(en.title).toBe('Hello');
    expect(en.excerpt).toBe('Short teaser');
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it('locale=fr без перевода → fallback на ru (база)', () => {
    const fr = toPublicNewsListDto(listRow(), PUB, FR);
    expect(fr.title).toBe('Привет');
  });

  it('coverUrl собирается из ключа; сырой ключ не утекает', () => {
    const dto = toPublicNewsListDto(listRow(), PUB, RU);
    expect(dto.coverUrl).toBe('https://cdn.test/news/cover.webp');
    expect(JSON.stringify(dto)).not.toContain('coverImageKey');
    // Скрыты служебные поля.
    expect((dto as unknown as Record<string, unknown>).id).toBeUndefined();
    expect((dto as unknown as Record<string, unknown>).status).toBeUndefined();
  });
});

describe('news-dto — деталь (detail)', () => {
  it('locale=en → переведённые title/body; ru fallback для fr', () => {
    const en = toPublicNewsDetailDto(article(), SEO, PUB, EN);
    const fr = toPublicNewsDetailDto(article(), SEO, PUB, FR);
    expect(en.title).toBe('Hello');
    expect(en.body).toBe('<p>Body</p>');
    expect(fr.title).toBe('Привет');
    expect(fr.body).toBe('<p>Тело</p>');
  });

  it('деталь несёт meta и coverUrl; скрывает служебные поля', () => {
    const dto = toPublicNewsDetailDto(article(), SEO, PUB, RU);
    expect(dto.meta).toBeDefined();
    expect(dto.meta.title).toBeTruthy();
    expect(dto.coverUrl).toBe('https://cdn.test/news/cover.webp');
    expect(dto.publishedAt).toBe(D.toISOString());
    const keys = Object.keys(dto);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('translations');
    expect(keys).not.toContain('coverImageKey');
  });
});
