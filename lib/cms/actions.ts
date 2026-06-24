'use server';

import type { TransactionSql } from 'postgres';

import { defineAction, PublicActionError, type ActionCtx } from '@/lib/server/action';
import { sql } from '@/lib/db/client';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';
import { validateUpload } from '@/lib/storage/validate';
import { generatePreviews } from '@/lib/storage/image';

import {
  CmsPageCreateSchema,
  CmsPageUpdateSchema,
  CmsPageIdSchema,
  CmsSectionInputSchema,
  CmsSectionReorderSchema,
  CmsSectionSetEnabledSchema,
  CmsSectionIdSchema,
  CmsImageUploadSchema,
} from './schemas';
import { CmsError } from './errors';
import { slugifyOrFallback, uniquifySlug } from './slug';
import { sanitizeSectionContent } from './sanitize-section';

/**
 * Server Actions подсистемы CMS (docs/11 §5.1.3, пакет 5.C-2, ADR-012).
 *
 * Все мутации — через единый пайплайн defineAction (§4.7 ядра): guard
 * (cms.write) → Zod → handler (БД через sql, параметризовано) → revalidate →
 * audit ('cms.page.*'/'cms.section.*'). Доменные ошибки — через CmsError (errors.ts).
 *
 * Флаг модуля: КАЖДЫЙ handler начинается с await assertCmsEnabled() — авторитетный
 * гейт (env ⊕ БД-оверрайд) при выключенном модуле cms бросает CmsError('module_disabled')
 * (помимо скрытия в UI и гейта Storefront-роутов через runStorefront(req, h, { module:'cms' })).
 *
 * 'use server'-файл экспортирует ТОЛЬКО async-функции: классы ошибок (CmsError),
 * схемы и чистый санитайзер живут в отдельных модулях (errors/schemas/sanitize-section).
 */

// -----------------------------------------------------------------------------
// Общие хелперы.
// -----------------------------------------------------------------------------

/** Бросает, если модуль CMS выключен (env ⊕ БД-оверрайд). */
async function assertCmsEnabled(): Promise<void> {
  if (!(await isModuleEffectivelyEnabled('cms'))) {
    throw new CmsError('module_disabled', 'Модуль «Контент» выключен.');
  }
}

/** Код нарушения уникальности PostgreSQL. */
const PG_UNIQUE_VIOLATION = '23505';

/** true, если ошибка — нарушение уникального индекса. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/** Пути инвалидации CMS. */
const CMS_LIST_PATH = '/admin/cms';
function cmsPagePath(id: string): string {
  return `/admin/cms/${id}`;
}
/** Карта сайта — инвалидируется при публикации/SEO-правках страниц. */
const SITEMAP_PATH = '/sitemap.xml';

/**
 * Вставляет страницу с ретраем slug при коллизии уникального индекса.
 * `insert(slug)` возвращает строку результата или бросает ошибку уникальности
 * (паттерн lib/catalog/actions.ts).
 */
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
  throw new CmsError('slug_conflict', 'Не удалось подобрать уникальный slug.');
}

// =============================================================================
// СТРАНИЦЫ (§5.1.3).
// =============================================================================

export const createCmsPage = defineAction({
  permission: 'cms.write',
  input: CmsPageCreateSchema,
  handler: async (data, ctx: ActionCtx) => {
    await assertCmsEnabled();
    // slugifyOrFallback (НЕ slugify): заголовок без латиницы/кириллицы/цифр
    // (эмодзи/иероглифы) даёт slugify('')==='' → пустой slug ломает ЧПУ/вставку.
    // Фолбэк 'page-<token>' гарантирует непустой валидный slug (как каталог).
    const base = data.slug || slugifyOrFallback(data.title, '', undefined, 'page');

    const row = await insertWithUniqueSlug(base, async (slug) => {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO cms_pages
          (slug, title, status, seo_title, seo_description, og_image_url,
           canonical_url, noindex, sitemap_priority, sitemap_changefreq,
           created_by, updated_by)
        VALUES (
          ${slug}, ${data.title}, ${data.status ?? 'draft'},
          ${data.seoTitle ?? null}, ${data.seoDescription ?? null},
          ${data.ogImageUrl ?? null}, ${data.canonicalUrl ?? null},
          ${data.noindex ?? false}, ${data.sitemapPriority ?? null},
          ${data.sitemapChangefreq ?? null},
          ${ctx.user.id}, ${ctx.user.id}
        )
        RETURNING id
      `;
      return rows[0]!;
    });

    return {
      result: { id: row.id },
      revalidate: [CMS_LIST_PATH, cmsPagePath(row.id)],
      audit: {
        action: 'cms.page.create',
        entityType: 'cms_page',
        entityId: row.id,
        after: { slug: base, title: data.title, status: data.status ?? 'draft' },
      },
    };
  },
});

export const updateCmsPage = defineAction({
  permission: 'cms.write',
  input: CmsPageUpdateSchema,
  handler: async (data, ctx) => {
    await assertCmsEnabled();
    const before = await sql<Record<string, unknown>[]>`
      SELECT * FROM cms_pages WHERE id = ${data.id} LIMIT 1
    `;
    if (!before[0]) {
      throw new CmsError('not_found', 'Страница не найдена.');
    }

    // Уникальный индекс slug может нарушиться при смене slug на уже занятый.
    // Ловим 23505 и отдаём ПОНЯТНОЕ сообщение (PublicActionError → validation),
    // иначе ошибка всплыла бы как невнятный 'internal' (образец createOrder для
    // duplicate_code). CmsError здесь не подходит — он не наследует PublicActionError.
    let after: Record<string, unknown>[];
    try {
      after = await sql<Record<string, unknown>[]>`
        UPDATE cms_pages SET
          slug               = COALESCE(${data.slug ?? null}, slug),
          title              = COALESCE(${data.title ?? null}, title),
          status             = COALESCE(${data.status ?? null}, status),
          seo_title          = CASE WHEN ${data.seoTitle !== undefined}
                                    THEN ${data.seoTitle ?? null} ELSE seo_title END,
          seo_description    = CASE WHEN ${data.seoDescription !== undefined}
                                    THEN ${data.seoDescription ?? null} ELSE seo_description END,
          og_image_url       = CASE WHEN ${data.ogImageUrl !== undefined}
                                    THEN ${data.ogImageUrl ?? null} ELSE og_image_url END,
          canonical_url      = CASE WHEN ${data.canonicalUrl !== undefined}
                                    THEN ${data.canonicalUrl ?? null} ELSE canonical_url END,
          noindex            = COALESCE(${data.noindex ?? null}, noindex),
          sitemap_priority   = CASE WHEN ${data.sitemapPriority !== undefined}
                                    THEN ${data.sitemapPriority ?? null} ELSE sitemap_priority END,
          sitemap_changefreq = CASE WHEN ${data.sitemapChangefreq !== undefined}
                                    THEN ${data.sitemapChangefreq ?? null} ELSE sitemap_changefreq END,
          updated_by         = ${ctx.user.id},
          updated_at         = now()
        WHERE id = ${data.id}
        RETURNING *
      `;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PublicActionError(
          'Страница с таким адресом (slug) уже существует.',
        );
      }
      throw err;
    }

    return {
      result: { id: data.id },
      revalidate: [CMS_LIST_PATH, cmsPagePath(data.id), SITEMAP_PATH],
      audit: {
        action: 'cms.page.update',
        entityType: 'cms_page',
        entityId: data.id,
        before: before[0],
        after: after[0],
      },
    };
  },
});

export const deleteCmsPage = defineAction({
  permission: 'cms.write',
  input: CmsPageIdSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();
    // CASCADE снимает cms_page_sections и cms_page_revisions (FK ON DELETE CASCADE).
    const rows = await sql<{ id: string; slug: string }[]>`
      DELETE FROM cms_pages WHERE id = ${data.id} RETURNING id, slug
    `;
    if (!rows[0]) {
      throw new CmsError('not_found', 'Страница не найдена.');
    }
    return {
      result: { id: data.id },
      revalidate: [CMS_LIST_PATH, SITEMAP_PATH],
      audit: {
        action: 'cms.page.delete',
        entityType: 'cms_page',
        entityId: data.id,
        before: { slug: rows[0].slug },
      },
    };
  },
});

export const publishCmsPage = defineAction({
  permission: 'cms.write',
  input: CmsPageIdSchema,
  handler: async (data, ctx) => {
    await assertCmsEnabled();

    // Транзакционно: status='published' + published_at=COALESCE(...,now()) и
    // снимок страницы+секций в cms_page_revisions (revision = max+1). Атомарность
    // гарантирует, что ревизия и публикация согласованы (образец createOrder).
    const result = await sql.begin(async (tx: TransactionSql) => {
      const pageRows = await tx<Record<string, unknown>[]>`
        UPDATE cms_pages SET
          status       = 'published',
          published_at = COALESCE(published_at, now()),
          updated_by   = ${ctx.user.id},
          updated_at   = now()
        WHERE id = ${data.id}
        RETURNING *
      `;
      if (!pageRows[0]) {
        throw new CmsError('not_found', 'Страница не найдена.');
      }

      const sectionRows = await tx<Record<string, unknown>[]>`
        SELECT id, page_id, section_key, type, content, display_order, enabled,
               created_at, updated_at
        FROM cms_page_sections
        WHERE page_id = ${data.id}
        ORDER BY display_order ASC, created_at ASC
      `;

      const maxRow = await tx<{ m: string }[]>`
        SELECT COALESCE(MAX(revision), 0)::text AS m
        FROM cms_page_revisions WHERE page_id = ${data.id}
      `;
      const nextRevision = Number(maxRow[0]?.m ?? 0) + 1;

      // Снимок страницы+секций как чистый JSON (Date → ISO-строки) для JSONB.
      const snapshot = JSON.parse(
        JSON.stringify({ page: pageRows[0], sections: sectionRows }),
      ) as Record<string, unknown>;
      await tx`
        INSERT INTO cms_page_revisions (page_id, revision, snapshot, created_by)
        VALUES (${data.id}, ${nextRevision},
                ${tx.json(snapshot as Record<string, never>)}, ${ctx.user.id})
      `;

      return { revision: nextRevision };
    });

    return {
      result: { id: data.id, revision: result.revision },
      revalidate: [CMS_LIST_PATH, cmsPagePath(data.id), SITEMAP_PATH],
      audit: {
        action: 'cms.page.publish',
        entityType: 'cms_page',
        entityId: data.id,
        after: { status: 'published', revision: result.revision },
      },
    };
  },
});

export const unpublishCmsPage = defineAction({
  permission: 'cms.write',
  input: CmsPageIdSchema,
  handler: async (data, ctx) => {
    await assertCmsEnabled();
    // Снятие с публикации → черновик; published_at оставляем как историческую метку.
    const rows = await sql<{ id: string }[]>`
      UPDATE cms_pages SET
        status     = 'draft',
        updated_by = ${ctx.user.id},
        updated_at = now()
      WHERE id = ${data.id}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new CmsError('not_found', 'Страница не найдена.');
    }
    return {
      result: { id: data.id },
      revalidate: [CMS_LIST_PATH, cmsPagePath(data.id), SITEMAP_PATH],
      audit: {
        action: 'cms.page.unpublish',
        entityType: 'cms_page',
        entityId: data.id,
        after: { status: 'draft' },
      },
    };
  },
});

// =============================================================================
// СЕКЦИИ (§5.1.3).
// =============================================================================

export const upsertCmsSection = defineAction({
  permission: 'cms.write',
  input: CmsSectionInputSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();

    // КЛЮЧЕВОЕ: content уже провалидирован дискриминированным union по type
    // (CmsSectionContentSchema в CmsSectionInputSchema). СЕРВЕРНАЯ санитизация
    // rich-text (анти-XSS, доверие клиенту запрещено) — перед записью в JSONB.
    const safeContent = sanitizeSectionContent(data.content);

    // type берём из дискриминированного content (единый источник правды).
    const type = safeContent.type;

    const rows = await sql<{ id: string }[]>`
      INSERT INTO cms_page_sections
        (page_id, section_key, type, content, display_order, enabled)
      VALUES (
        ${data.pageId}, ${data.sectionKey}, ${type},
        ${sql.json(safeContent as unknown as Record<string, never>)}, ${data.displayOrder}, ${data.enabled}
      )
      ON CONFLICT (page_id, section_key) DO UPDATE SET
        type          = EXCLUDED.type,
        content       = EXCLUDED.content,
        display_order = EXCLUDED.display_order,
        enabled       = EXCLUDED.enabled,
        updated_at    = now()
      RETURNING id
    `;

    return {
      result: { id: rows[0]!.id },
      revalidate: [cmsPagePath(data.pageId)],
      audit: {
        action: 'cms.section.upsert',
        entityType: 'cms_page_section',
        entityId: rows[0]!.id,
        after: { pageId: data.pageId, sectionKey: data.sectionKey, type },
      },
    };
  },
});

export const reorderCmsSections = defineAction({
  permission: 'cms.write',
  input: CmsSectionReorderSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();
    // Транзакционно: все секции страницы получают новый display_order атомарно
    // (частичный reorder не оставляет несогласованного порядка).
    await sql.begin(async (tx: TransactionSql) => {
      for (const item of data.order) {
        await tx`
          UPDATE cms_page_sections
             SET display_order = ${item.displayOrder}, updated_at = now()
           WHERE id = ${item.id} AND page_id = ${data.pageId}
        `;
      }
    });
    return {
      result: { pageId: data.pageId },
      revalidate: [cmsPagePath(data.pageId)],
      audit: {
        action: 'cms.section.reorder',
        entityType: 'cms_page',
        entityId: data.pageId,
        after: { order: data.order },
      },
    };
  },
});

export const setCmsSectionEnabled = defineAction({
  permission: 'cms.write',
  input: CmsSectionSetEnabledSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();
    const rows = await sql<{ id: string; page_id: string }[]>`
      UPDATE cms_page_sections
         SET enabled = ${data.enabled}, updated_at = now()
       WHERE id = ${data.id}
      RETURNING id, page_id
    `;
    if (!rows[0]) {
      throw new CmsError('not_found', 'Секция не найдена.');
    }
    return {
      result: { id: data.id, enabled: data.enabled },
      revalidate: [cmsPagePath(rows[0].page_id)],
      audit: {
        action: 'cms.section.enable',
        entityType: 'cms_page_section',
        entityId: data.id,
        after: { enabled: data.enabled },
      },
    };
  },
});

export const deleteCmsSection = defineAction({
  permission: 'cms.write',
  input: CmsSectionIdSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();
    const rows = await sql<{ id: string; page_id: string }[]>`
      DELETE FROM cms_page_sections WHERE id = ${data.id}
      RETURNING id, page_id
    `;
    if (!rows[0]) {
      throw new CmsError('not_found', 'Секция не найдена.');
    }
    return {
      result: { id: data.id },
      revalidate: [cmsPagePath(rows[0].page_id)],
      audit: {
        action: 'cms.section.delete',
        entityType: 'cms_page_section',
        entityId: data.id,
      },
    };
  },
});

// =============================================================================
// ЗАГРУЗКА ИЗОБРАЖЕНИЙ СЕКЦИЙ (ADR-018).
// =============================================================================

/**
 * Внутренний action загрузки CMS-изображения: пайплайн медиа (validateUpload
 * magic-bytes → generatePreviews webp → storage.put). ВОЗВРАЩАЕТ S3-ключ —
 * CMS-секции хранят imageKey (не URL), контракт ADR-012. Ключ генерируется
 * сервером (анти-path-traversal): cms/<uuid>.webp.
 */
const _uploadCmsImage = defineAction({
  permission: 'cms.write',
  input: CmsImageUploadSchema,
  handler: async (data, _ctx) => {
    await assertCmsEnabled();

    const validation = await validateUpload(data.bytes, data.filename);
    if (!validation.ok || !validation.mime) {
      throw new PublicActionError(validation.error ?? 'Недопустимый файл.');
    }

    const previews = await generatePreviews(data.bytes);
    const main = previews.main;

    const storage = getStorage();
    const key = `cms/${crypto.randomUUID()}.webp`;
    let put;
    try {
      put = await storage.put(key, main.buffer, 'image/webp');
    } catch {
      throw new PublicActionError('Не удалось сохранить файл в хранилище.');
    }

    return {
      // url отдаём для предпросмотра в форме; в content секции сохраняется key.
      result: { key: put.key, url: put.url },
      audit: {
        action: 'cms.image.upload',
        entityType: 'cms_image',
        entityId: put.key,
        after: { key: put.key },
      },
    };
  },
});

/**
 * Загрузка изображения CMS из FormData (Server Action для формы редактора секций).
 * Извлекает байты файла на сервере и делегирует внутреннему action. Возвращает
 * S3-ключ (imageKey), который UI подставит в поле секции (hero/banner/gallery).
 */
export async function uploadCmsImageAction(formData: FormData) {
  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return _uploadCmsImage({ filename: 'upload', bytes: undefined });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const filename = file instanceof File ? file.name : 'upload';
  return _uploadCmsImage({ filename, bytes });
}
