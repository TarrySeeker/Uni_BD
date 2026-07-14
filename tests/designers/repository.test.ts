import { afterAll, describe, expect, it } from 'vitest';

import { mapDesigner } from '@/lib/designers/repository';
import { localizeEntity } from '@/lib/storefront/locale';
import { DESIGNER_TR_FIELDS } from '@/lib/i18n';

/**
 * (а) ЮНИТ — маппер row→domain (без БД).
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — реальная БД :5434, миграция 0047:
 *     round-trip insert→getBySlug/getById; activeOnly-фильтр; i18n translations
 *     персистятся под CHECK jsonb_typeof='object'; локализация en→en / fallback ru;
 *     products.designer_id FK + ON DELETE SET NULL при удалении дизайнера.
 *
 * Инвариант «dev-данные целы»: все фикстуры удаляются в afterAll.
 */

// =============================================================================
// (а) ЮНИТ — маппер.
// =============================================================================
describe('designers/repository — mapDesigner (юнит)', () => {
  it('snake→camel, socials/translations как объекты', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const d = mapDesigner({
      id: 'd1', slug: 'jane-doe', name: 'Jane Doe', country: 'Франция',
      description: '<p>био</p>', image_key: 'designers/a.webp',
      page_image_key: 'designers/p.webp', video_url: 'https://vimeo.com/1',
      socials: { instagram: 'https://ig/jane' }, work_count: 12,
      is_active: true, sort: 3, seo_title: 's', seo_description: 'sd',
      og_title: 'ot', og_description: 'od', og_image_key: 'designers/og.webp',
      canonical_url: null, noindex: false,
      translations: { en: { name: 'Jane', country: 'France' } },
      created_at: now, updated_at: now,
    });
    expect(d.slug).toBe('jane-doe');
    expect(d.country).toBe('Франция');
    expect(d.workCount).toBe(12);
    expect(d.imageKey).toBe('designers/a.webp');
    expect(d.pageImageKey).toBe('designers/p.webp');
    expect(d.socials).toEqual({ instagram: 'https://ig/jane' });
    expect(d.translations).toEqual({ en: { name: 'Jane', country: 'France' } });
  });

  it('не-объект socials/translations → {}; null-поля → null/дефолты', () => {
    const now = new Date();
    const d = mapDesigner({
      id: 'd', slug: 's', name: 'n', country: null, description: null,
      socials: null, translations: 'not-json', work_count: null,
      is_active: false, sort: null, noindex: null,
      created_at: now, updated_at: now,
    });
    expect(d.socials).toEqual({});
    expect(d.translations).toEqual({});
    expect(d.country).toBeNull();
    expect(d.description).toBe('');
    expect(d.workCount).toBe(0);
    expect(d.sort).toBe(0);
    expect(d.isActive).toBe(false);
  });

  it('localizeEntity локализует name/description/country по en, иначе fallback ru', () => {
    const now = new Date();
    const base = mapDesigner({
      id: 'd', slug: 's', name: 'Иван', country: 'Россия', description: 'опис',
      socials: {}, translations: { en: { name: 'Ivan', country: 'Russia' } },
      is_active: true, created_at: now, updated_at: now,
    });
    const en = localizeEntity(base, DESIGNER_TR_FIELDS, { locale: 'en', defaultLocale: 'ru' });
    expect(en.name).toBe('Ivan');
    expect(en.country).toBe('Russia');
    // description без перевода → база ru.
    expect(en.description).toBe('опис');
    // ru (default) — база без изменений.
    const ru = localizeEntity(base, DESIGNER_TR_FIELDS, { locale: 'ru', defaultLocale: 'ru' });
    expect(ru.name).toBe('Иван');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('designers/repository (интеграция, нужна БД)', () => {
  let repo: typeof import('@/lib/designers/repository');
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;

  const tag = 'itdes-' + Math.random().toString(36).slice(2, 8);
  const designerIds: string[] = [];
  const productIds: string[] = [];

  async function ready() {
    if (!repo) {
      repo = await import('@/lib/designers/repository');
      const client = await import('@/lib/db/client');
      sql = client.sql;
      closeSql = client.closeSql;
    }
  }

  async function makeDesigner(
    over: Partial<{ slug: string; name: string; isActive: boolean; translations: object }> = {},
  ): Promise<string> {
    await ready();
    const slug = over.slug ?? `${tag}-${Math.random().toString(36).slice(2, 7)}`;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO designers (slug, name, country, description, socials, translations, is_active)
      VALUES (
        ${slug}, ${over.name ?? 'Тест Персона'}, 'Россия', 'база',
        ${sql.json({ instagram: 'https://ig/x' })},
        ${sql.json((over.translations ?? {}) as Record<string, never>)},
        ${over.isActive ?? true}
      )
      RETURNING id
    `;
    designerIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  afterAll(async () => {
    await ready();
    if (productIds.length) {
      await sql`DELETE FROM products WHERE id = ANY(${productIds}::uuid[])`;
    }
    if (designerIds.length) {
      await sql`DELETE FROM designers WHERE id = ANY(${designerIds}::uuid[])`;
    }
    await closeSql();
  });

  it('round-trip: insert → getDesignerById / getDesignerBySlug', async () => {
    const slug = `${tag}-rt`;
    const id = await makeDesigner({ slug, name: 'Раунд Трип' });
    const byId = await repo.getDesignerById(id);
    expect(byId?.name).toBe('Раунд Трип');
    expect(byId?.socials).toEqual({ instagram: 'https://ig/x' });
    const bySlug = await repo.getDesignerBySlug(slug);
    expect(bySlug?.id).toBe(id);
  });

  it('activeOnly скрывает неактивных; getActiveDesignerBySlug возвращает null для неактивного', async () => {
    const slug = `${tag}-inactive`;
    await makeDesigner({ slug, isActive: false });
    const all = await repo.listDesigners();
    const activeOnly = await repo.listDesigners({ activeOnly: true });
    expect(all.some((d) => d.slug === slug)).toBe(true);
    expect(activeOnly.some((d) => d.slug === slug)).toBe(false);
    expect(await repo.getActiveDesignerBySlug(slug)).toBeNull();
  });

  it('i18n: translations персистятся и локализуются en→en, иначе ru', async () => {
    const slug = `${tag}-i18n`;
    const id = await makeDesigner({
      slug, name: 'Иван', translations: { en: { name: 'Ivan', country: 'Russia' } },
    });
    const d = await repo.getDesignerById(id);
    expect(d?.translations).toEqual({ en: { name: 'Ivan', country: 'Russia' } });
    const en = localizeEntity(d!, DESIGNER_TR_FIELDS, { locale: 'en', defaultLocale: 'ru' });
    expect(en.name).toBe('Ivan');
    expect(en.country).toBe('Russia');
  });

  it('products.designer_id: ON DELETE SET NULL при удалении дизайнера', async () => {
    await ready();
    const designerId = await makeDesigner({ slug: `${tag}-fk` });
    const suffix = Date.now().toString(36);
    const prod = await sql<{ id: string }[]>`
      INSERT INTO products (sku, slug, name, status, base_price, designer_id)
      VALUES (${'des-sku-' + suffix}, ${'des-slug-' + suffix}, 'Товар с дизайнером',
              'active', '100.00', ${designerId})
      RETURNING id
    `;
    const productId = prod[0]!.id;
    productIds.push(productId);

    // Привязка есть.
    const before = await sql<{ designer_id: string | null }[]>`
      SELECT designer_id FROM products WHERE id = ${productId}
    `;
    expect(before[0]!.designer_id).toBe(designerId);

    // Удаляем дизайнера — товар остаётся, designer_id обнуляется.
    await sql`DELETE FROM designers WHERE id = ${designerId}`;
    designerIds.splice(designerIds.indexOf(designerId), 1);

    const after = await sql<{ id: string; designer_id: string | null }[]>`
      SELECT id, designer_id FROM products WHERE id = ${productId}
    `;
    expect(after.length).toBe(1); // товар НЕ удалён
    expect(after[0]!.designer_id).toBeNull(); // привязка снята
  });
});
