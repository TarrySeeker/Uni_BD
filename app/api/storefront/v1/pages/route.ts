/**
 * GET /api/storefront/v1/pages — список опубликованных CMS-страниц (docs/11 §5.1.4).
 *
 * Для навигации витрины: slug + title + SEO-мета каждой страницы (без секций).
 * Гейт module:'cms' ОБЯЗАТЕЛЕН. Отдаёт только status='published' (фильтр в
 * репозитории listPublishedCmsPages); внутренние поля скрыты в DTO.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { listPublishedCmsPages } from '@/lib/cms/repository';
import { toPublicPageListItemDto } from '@/lib/storefront/cms-dto';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const pages = await listPublishedCmsPages();

      const settings = await getEffectiveSettings();
      const storage = getStorage();
      const seoCtx = buildEntitySeoCtx(settings, (k) => storage.url(k), 'page');

      const data = pages.map((p) => toPublicPageListItemDto(p, seoCtx));
      return jsonData(data, { count: data.length }, cors);
    },
    { module: 'cms' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
