/**
 * GET /api/storefront/v1/news/[slug] — публичная новость (docs/24 §3).
 *
 * Гейт module:'news' ОБЯЗАТЕЛЕН. Отдаёт ТОЛЬКО status='published' новость по slug
 * (фильтр в репозитории getPublishedNewsBySlug); draft/archived ⇒ null ⇒ единый
 * 404 not_found. Внутренние поля (id/status/audit/timestamps/сырые S3-ключи) скрыты
 * в toPublicNewsDetailDto; переводимые поля резолвятся по ctx.locale.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { getPublishedNewsBySlug } from '@/lib/news/repository';
import { toPublicNewsDetailDto } from '@/lib/storefront/news-dto';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return runStorefront(
    req,
    async (sfCtx) => {
      const { cors } = sfCtx;
      const loc = localizeCtxFrom(sfCtx);
      const { slug } = await ctx.params;

      const article = await getPublishedNewsBySlug(slug);
      if (!article) {
        return jsonError('not_found', 'Новость не найдена.', cors);
      }

      const settings = await getEffectiveSettings();
      const storage = getStorage();
      const publicUrl = (k: string) => storage.url(k);
      const seoCtx = buildEntitySeoCtx(settings, publicUrl, 'news');

      return jsonData(toPublicNewsDetailDto(article, seoCtx, publicUrl, loc), {}, cors);
    },
    { module: 'news' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
