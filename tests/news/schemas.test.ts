import { describe, expect, it } from 'vitest';

import {
  NewsCreateSchema,
  NewsUpdateSchema,
  NewsSetStatusSchema,
  NewsListFilterSchema,
} from '@/lib/news/schemas';
import { NEWS_TRANSLATABLE_FIELDS } from '@/lib/news/fields';

/**
 * ЮНИТ (без БД): Zod-схемы новостей (docs/24 §3). Валидные/невалидные входы,
 * длины, slug-regex, whitelist переводимых полей, статус-enum.
 */
describe('news/schemas — создание', () => {
  it('минимальный валидный вход (только title)', () => {
    const r = NewsCreateSchema.safeParse({ title: 'Новость дня' });
    expect(r.success).toBe(true);
  });

  it('пустой title → ошибка', () => {
    const r = NewsCreateSchema.safeParse({ title: '   ' });
    expect(r.success).toBe(false);
  });

  it('невалидный slug (пробелы/кириллица) → ошибка', () => {
    const r = NewsCreateSchema.safeParse({ title: 'X', slug: 'плохой slug' });
    expect(r.success).toBe(false);
  });

  it('валидный slug (a-z0-9-) проходит', () => {
    const r = NewsCreateSchema.safeParse({ title: 'X', slug: 'novost-dnya-2026' });
    expect(r.success).toBe(true);
  });

  it('excerpt длиннее 1000 → ошибка', () => {
    const r = NewsCreateSchema.safeParse({ title: 'X', excerpt: 'a'.repeat(1001) });
    expect(r.success).toBe(false);
  });

  it("status 'published' в create ЗАПРЕЩЁН (только draft/archived)", () => {
    expect(NewsCreateSchema.safeParse({ title: 'X', status: 'published' }).success).toBe(false);
    expect(NewsCreateSchema.safeParse({ title: 'X', status: 'draft' }).success).toBe(true);
    expect(NewsCreateSchema.safeParse({ title: 'X', status: 'archived' }).success).toBe(true);
  });

  it('publishedAt ISO-строка → Date', () => {
    const r = NewsCreateSchema.safeParse({ title: 'X', publishedAt: '2026-07-13T10:00:00Z' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.publishedAt).toBeInstanceOf(Date);
  });
});

describe('news/schemas — обновление', () => {
  it('id обязателен', () => {
    expect(NewsUpdateSchema.safeParse({ title: 'X' }).success).toBe(false);
    expect(
      NewsUpdateSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', title: 'X' }).success,
    ).toBe(true);
  });

  it('блок translations принимается (грубая форма)', () => {
    const r = NewsUpdateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      translations: { en: { title: 'Day news', body: '<p>Hi</p>' } },
    });
    expect(r.success).toBe(true);
  });
});

describe('news/schemas — статус и фильтр', () => {
  it('setStatus принимает все три статуса', () => {
    for (const s of ['draft', 'published', 'archived']) {
      expect(
        NewsSetStatusSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', status: s }).success,
      ).toBe(true);
    }
  });

  it('фильтр списка: дефолты page/pageSize', () => {
    const r = NewsListFilterSchema.parse({});
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });
});

describe('news/fields — whitelist переводимых полей', () => {
  it('содержит контентные + SEO/OG поля, НЕ содержит slug/дат/статуса', () => {
    expect(NEWS_TRANSLATABLE_FIELDS).toContain('title');
    expect(NEWS_TRANSLATABLE_FIELDS).toContain('excerpt');
    expect(NEWS_TRANSLATABLE_FIELDS).toContain('body');
    expect(NEWS_TRANSLATABLE_FIELDS).toContain('groupLabel');
    expect(NEWS_TRANSLATABLE_FIELDS).toContain('seoTitle');
    expect(NEWS_TRANSLATABLE_FIELDS as readonly string[]).not.toContain('slug');
    expect(NEWS_TRANSLATABLE_FIELDS as readonly string[]).not.toContain('status');
    expect(NEWS_TRANSLATABLE_FIELDS as readonly string[]).not.toContain('publishedAt');
  });
});
