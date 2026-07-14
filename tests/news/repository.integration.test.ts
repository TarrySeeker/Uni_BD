import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mapNews, mapNewsListRow } from '@/lib/news/repository';

/**
 * (а) ЮНИТ — мапперы row→domain (всегда зелёные, без БД).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД на :5434, миграция 0042.
 *     Round-trip: insert→getBySlug; getPublishedNews только published + пагинация
 *     без потерь; getPublishedNewsBySlug (draft→null); updateNewsStatus проставляет
 *     published_at; i18n translations персистятся под CHECK jsonb_typeof='object';
 *     listNews поиск+пагинация; delete.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

// =============================================================================
// (а) ЮНИТ — мапперы.
// =============================================================================
describe('news/repository — мапперы row→domain (юнит)', () => {
  it('mapNews: snake→camel, translations как есть', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const a = mapNews({
      id: 'n1', slug: 'welcome', title: 'Привет', group_label: 'Анонсы',
      excerpt: 'анонс', body: '<p>x</p>', cover_image_key: 'news/c.webp',
      status: 'published', published_at: now, sort_order: 3,
      seo_title: 's', seo_description: 'd', og_title: 'ot', og_description: 'od',
      og_image_key: 'news/og.webp', noindex: false, canonical_url: null,
      translations: { en: { title: 'Hello' } }, created_by: null, updated_by: null,
      created_at: now, updated_at: now,
    });
    expect(a.slug).toBe('welcome');
    expect(a.sortOrder).toBe(3);
    expect(a.translations).toEqual({ en: { title: 'Hello' } });
    expect(a.coverImageKey).toBe('news/c.webp');
  });

  it('mapNews: не-объект translations → {}', () => {
    const now = new Date();
    const a = mapNews({ id: 'n', slug: 's', title: 't', status: 'draft',
      translations: null, created_at: now, updated_at: now });
    expect(a.translations).toEqual({});
    expect(a.publishedAt).toBeNull();
  });

  it('mapNewsListRow: без body', () => {
    const now = new Date();
    const r = mapNewsListRow({ id: 'n', slug: 's', title: 't', status: 'published',
      published_at: now, sort_order: 0, translations: {}, updated_at: now });
    expect('body' in r).toBe(false);
    expect(r.status).toBe('published');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('news/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/news/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const createdIds: string[] = [];
  const tag = 'itnews-' + Math.random().toString(36).slice(2, 8);

  async function make(
    over: Partial<{
      slug: string; title: string; status: string; group: string;
      publishedAt: Date | null; sort: number;
    }> = {},
  ): Promise<{ id: string }> {
    const res = await repo.insertNews({
      slug: over.slug ?? `${tag}-${Math.random().toString(36).slice(2, 8)}`,
      title: over.title ?? 'Заголовок',
      groupLabel: over.group ?? tag, // рубрика = tag → фильтр group изолирует наши записи
      excerpt: 'анонс',
      body: '<p>тело</p>',
      coverImageKey: null,
      status: (over.status ?? 'draft') as never,
      publishedAt: over.publishedAt ?? null,
      sortOrder: over.sort ?? 0,
      seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null,
      ogImageKey: null, noindex: false, canonicalUrl: null, createdBy: null,
    });
    createdIds.push(res.id);
    return res;
  }

  beforeAll(async () => {
    repo = await import('@/lib/news/repository');
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await sql`DELETE FROM news WHERE id = ${id}`;
    }
    if (closeSql) await closeSql();
  });

  it('insert→getBySlug round-trip', async () => {
    const slug = `${tag}-rt`;
    await make({ slug, title: 'Круговорот' });
    const a = await repo.getNewsBySlug(slug);
    expect(a).not.toBeNull();
    expect(a!.title).toBe('Круговорот');
    expect(a!.body).toBe('<p>тело</p>');
  });

  it('getPublishedNews отдаёт ТОЛЬКО published (draft скрыт)', async () => {
    await make({ status: 'published', publishedAt: new Date() });
    await make({ status: 'draft' });
    const { rows, total } = await repo.getPublishedNews({ limit: 50, offset: 0, group: tag });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('пагинация getPublishedNews не теряет/не дублирует записи', async () => {
    // 3 опубликованные с разным sort_order.
    const g = `${tag}-pg`;
    await make({ status: 'published', publishedAt: new Date(), group: g, sort: 1 });
    await make({ status: 'published', publishedAt: new Date(), group: g, sort: 2 });
    await make({ status: 'published', publishedAt: new Date(), group: g, sort: 3 });
    const p1 = await repo.getPublishedNews({ limit: 2, offset: 0, group: g });
    const p2 = await repo.getPublishedNews({ limit: 2, offset: 2, group: g });
    expect(p1.total).toBe(3);
    expect(p1.rows.length).toBe(2);
    expect(p2.rows.length).toBe(1);
    const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    expect(ids.size).toBe(3); // без дублей между страницами
  });

  it('getPublishedNewsBySlug: draft → null; published → найдено', async () => {
    const draftSlug = `${tag}-draft`;
    const pubSlug = `${tag}-pub`;
    await make({ slug: draftSlug, status: 'draft' });
    await make({ slug: pubSlug, status: 'published', publishedAt: new Date() });
    expect(await repo.getPublishedNewsBySlug(draftSlug)).toBeNull();
    expect(await repo.getPublishedNewsBySlug(pubSlug)).not.toBeNull();
  });

  it('updateNewsStatus draft→published проставляет published_at', async () => {
    const { id } = await make({ status: 'draft' });
    const before = await repo.getNewsById(id);
    expect(before!.publishedAt).toBeNull();
    const after = await repo.updateNewsStatus(id, 'published', null);
    expect(after!.status).toBe('published');
    expect(after!.publishedAt).not.toBeNull();
  });

  it('i18n: translations en/fr персистятся под реальным CHECK', async () => {
    const { id } = await make({ status: 'draft' });
    const updated = await repo.updateNews({
      id,
      groupLabelProvided: false, excerptProvided: false, bodyProvided: false,
      coverImageKeyProvided: false, publishedAtProvided: false,
      seoTitleProvided: false, seoDescriptionProvided: false, ogTitleProvided: false,
      ogDescriptionProvided: false, ogImageKeyProvided: false, canonicalUrlProvided: false,
      translations: { en: { title: 'Hello' }, fr: { title: 'Bonjour' } },
      translationsProvided: true,
      updatedBy: null,
    });
    expect(updated!.translations).toEqual({ en: { title: 'Hello' }, fr: { title: 'Bonjour' } });
    const reread = await repo.getNewsById(id);
    expect(reread!.translations.en).toEqual({ title: 'Hello' });
  });

  it('listNews: поиск по заголовку + пагинация', async () => {
    const uniq = `${tag}-search-uniq`;
    await make({ title: uniq, status: 'draft' });
    const { rows, total } = await repo.listNews({ search: uniq, page: 1, pageSize: 20 });
    expect(total).toBe(1);
    expect(rows[0]!.title).toBe(uniq);
  });

  it('deleteNews удаляет запись', async () => {
    const { id } = await make({ status: 'draft' });
    const removed = await repo.deleteNews(id);
    expect(removed).not.toBeNull();
    expect(await repo.getNewsById(id)).toBeNull();
  });
});
