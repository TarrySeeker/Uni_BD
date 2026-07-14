'use server';

import { defineAction } from '@/lib/server/action';
import { sql } from '@/lib/db/client';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { getLocaleConfig, resolveTranslationsUpdate, DESIGNER_TR_FIELDS } from '@/lib/i18n';
import type { TranslationsMap } from '@/lib/i18n';
import { getStorage } from '@/lib/storage';
import { validateUpload } from '@/lib/storage/validate';
import { generatePreviews } from '@/lib/storage/image';
import { slugifyOrFallback, uniquifySlug } from '@/lib/catalog/slug';

import {
  DesignerCreateSchema,
  DesignerUpdateSchema,
  DesignerIdSchema,
  DesignerSetActiveSchema,
  DesignerImageUploadSchema,
} from './schemas';
import { DesignerError } from './errors';

/**
 * Server Actions дизайнеров (§9, ADR §4.4). Зеркало брендовых createBrand/…:
 * guard (catalog.write) → Zod → handler (sql, параметризовано) → revalidate → audit.
 *
 * Дизайнер живёт под модулем catalog (assertCatalogEnabled) — отдельного модуля
 * НЕ заводим; права те же catalog.read/write, что и у брендов.
 */

// -----------------------------------------------------------------------------
// Хелперы (локальны: actions.ts под 'use server' может экспортировать только async).
// -----------------------------------------------------------------------------

async function assertCatalogEnabled(): Promise<void> {
  if (!(await isModuleEffectivelyEnabled('catalog'))) {
    throw new DesignerError('module_disabled', 'Модуль «Каталог» выключен.');
  }
}

const PG_UNIQUE_VIOLATION = '23505';
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/** Вставка с ретраем slug при коллизии уникального индекса (как в каталоге). */
async function insertWithUniqueSlug<T>(
  baseSlug: string,
  insert: (slug: string) => Promise<T>,
  maxAttempts = 6,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = uniquifySlug(baseSlug, attempt);
    try {
      return await insert(candidate);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < maxAttempts - 1) {
        continue;
      }
      throw err;
    }
  }
  throw new DesignerError('slug_conflict', 'Не удалось подобрать уникальный slug.');
}

const DESIGNERS_PATH = '/admin/catalog/designers';
function designerPath(id: string): string {
  return `/admin/catalog/designers/${id}`;
}
const CATALOG_LIST_PATH = '/admin/catalog';
const SITEMAP_PATH = '/sitemap.xml';

// -----------------------------------------------------------------------------
// CRUD.
// -----------------------------------------------------------------------------

export const createDesigner = defineAction({
  permission: 'catalog.write',
  input: DesignerCreateSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    const base = data.slug || slugifyOrFallback(data.name, '', undefined, 'designer');

    const row = await insertWithUniqueSlug(base, async (slug) => {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO designers
          (slug, name, country, description, video_url, socials, work_count,
           is_active, sort, seo_title, seo_description)
        VALUES (
          ${slug}, ${data.name}, ${data.country ?? null}, ${data.description ?? ''},
          ${data.videoUrl ?? null}, ${sql.json((data.socials ?? {}) as Record<string, never>)},
          ${data.workCount ?? 0}, ${data.isActive ?? true}, ${data.sort ?? 0},
          ${data.seoTitle ?? null}, ${data.seoDescription ?? null}
        )
        RETURNING id
      `;
      return rows[0]!;
    });

    return {
      result: { id: row.id },
      revalidate: [DESIGNERS_PATH, CATALOG_LIST_PATH],
      audit: {
        action: 'catalog.designer.create',
        entityType: 'designer',
        entityId: row.id,
        after: { slug: base, name: data.name },
      },
    };
  },
});

export const updateDesigner = defineAction({
  permission: 'catalog.write',
  input: DesignerUpdateSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    const before = await sql<Record<string, unknown>[]>`
      SELECT * FROM designers WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new DesignerError('not_found', 'Дизайнер не найден.');
    }
    // Оверлей переводов: whitelist DESIGNER_TR_FIELDS, только не-дефолтные языки.
    const localeConfig = await getLocaleConfig();
    const tr = resolveTranslationsUpdate(
      DESIGNER_TR_FIELDS,
      data.translations,
      before[0].translations as TranslationsMap | null,
      localeConfig,
    );
    const socialsProvided = data.socials !== undefined;
    const after = await sql<Record<string, unknown>[]>`
      UPDATE designers SET
        slug            = COALESCE(${data.slug ?? null}, slug),
        name            = COALESCE(${data.name ?? null}, name),
        country         = CASE WHEN ${data.country !== undefined}
                               THEN ${data.country ?? null} ELSE country END,
        description     = COALESCE(${data.description ?? null}, description),
        video_url       = CASE WHEN ${data.videoUrl !== undefined}
                               THEN ${data.videoUrl ?? null} ELSE video_url END,
        socials         = CASE WHEN ${socialsProvided}
                               THEN ${sql.json((data.socials ?? {}) as Record<string, never>)}
                               ELSE socials END,
        work_count      = COALESCE(${data.workCount ?? null}, work_count),
        is_active       = COALESCE(${data.isActive ?? null}, is_active),
        sort            = COALESCE(${data.sort ?? null}, sort),
        seo_title       = COALESCE(${data.seoTitle ?? null}, seo_title),
        seo_description = COALESCE(${data.seoDescription ?? null}, seo_description),
        og_title        = CASE WHEN ${data.ogTitle !== undefined}
                               THEN ${data.ogTitle ?? null} ELSE og_title END,
        og_description  = CASE WHEN ${data.ogDescription !== undefined}
                               THEN ${data.ogDescription ?? null} ELSE og_description END,
        og_image_key    = CASE WHEN ${data.ogImageKey !== undefined}
                               THEN ${data.ogImageKey ?? null} ELSE og_image_key END,
        canonical_url   = CASE WHEN ${data.canonicalUrl !== undefined}
                               THEN ${data.canonicalUrl ?? null} ELSE canonical_url END,
        noindex         = COALESCE(${data.noindex ?? null}, noindex),
        translations    = CASE WHEN ${tr.provided}
                               THEN ${sql.json(tr.value as Record<string, never>)}
                               ELSE translations END,
        updated_at      = now()
      WHERE id = ${data.id}
      RETURNING *
    `;
    return {
      result: { id: data.id },
      revalidate: [DESIGNERS_PATH, designerPath(data.id), SITEMAP_PATH],
      audit: {
        action: 'catalog.designer.update',
        entityType: 'designer',
        entityId: data.id,
        before: before[0],
        after: after[0],
      },
    };
  },
});

export const setDesignerActive = defineAction({
  permission: 'catalog.write',
  input: DesignerSetActiveSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    const rows = await sql<{ id: string }[]>`
      UPDATE designers SET is_active = ${data.isActive}, updated_at = now()
      WHERE id = ${data.id}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new DesignerError('not_found', 'Дизайнер не найден.');
    }
    return {
      result: { id: data.id },
      revalidate: [DESIGNERS_PATH, designerPath(data.id), CATALOG_LIST_PATH],
      audit: {
        action: 'catalog.designer.set_active',
        entityType: 'designer',
        entityId: data.id,
        after: { isActive: data.isActive },
      },
    };
  },
});

export const deleteDesigner = defineAction({
  permission: 'catalog.write',
  input: DesignerIdSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    // ON DELETE SET NULL: товары не удаляются, у них обнуляется designer_id.
    const rows = await sql<{ id: string; image_key: string | null; page_image_key: string | null }[]>`
      DELETE FROM designers WHERE id = ${data.id}
      RETURNING id, image_key, page_image_key
    `;
    if (!rows[0]) {
      throw new DesignerError('not_found', 'Дизайнер не найден.');
    }
    const storage = getStorage();
    for (const key of [rows[0].image_key, rows[0].page_image_key]) {
      if (key) {
        await storage.delete(key).catch(() => {});
      }
    }
    return {
      result: { id: data.id },
      revalidate: [DESIGNERS_PATH, CATALOG_LIST_PATH],
      audit: {
        action: 'catalog.designer.delete',
        entityType: 'designer',
        entityId: data.id,
      },
    };
  },
});

export const uploadDesignerImage = defineAction({
  permission: 'catalog.write',
  input: DesignerImageUploadSchema,
  handler: async (data) => {
    await assertCatalogEnabled();

    const designer = await sql<{ id: string; image_key: string | null }[]>`
      SELECT id, image_key FROM designers WHERE id = ${data.designerId} LIMIT 1
    `;
    if (!designer[0]) {
      throw new DesignerError('not_found', 'Дизайнер не найден.');
    }

    const validation = await validateUpload(data.bytes, data.filename);
    if (!validation.ok || !validation.mime) {
      throw new DesignerError('invalid_media', validation.error ?? 'Недопустимый файл.');
    }

    const previews = await generatePreviews(data.bytes);
    const storage = getStorage();
    const key = `designers/${data.designerId}/${crypto.randomUUID()}.webp`;
    let put;
    try {
      put = await storage.put(key, previews.main.buffer, 'image/webp');
    } catch {
      throw new DesignerError('storage_failed', 'Не удалось сохранить файл в хранилище.');
    }

    try {
      await sql`
        UPDATE designers SET image_key = ${put.key}, updated_at = now()
        WHERE id = ${data.designerId}
      `;
    } catch (err) {
      await storage.delete(put.key).catch(() => {});
      throw err;
    }

    const prevKey = designer[0].image_key;
    if (prevKey && prevKey !== put.key) {
      await storage.delete(prevKey).catch(() => {});
    }

    return {
      result: { id: data.designerId, url: put.url, key: put.key },
      revalidate: [DESIGNERS_PATH, designerPath(data.designerId)],
      audit: {
        action: 'catalog.designer.image.upload',
        entityType: 'designer',
        entityId: data.designerId,
        after: { key: put.key },
      },
    };
  },
});
