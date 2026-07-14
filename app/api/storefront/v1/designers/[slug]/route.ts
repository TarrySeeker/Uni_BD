/**
 * GET /api/storefront/v1/designers/[slug] — публичная страница дизайнера
 * (§9, ADR §4.4). Только is_active=true (getActiveDesignerBySlug); иначе 404.
 * Внутренние поля скрыты в toFullDesignerDto; переводимые резолвятся по ctx.locale.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { getActiveDesignerBySlug } from '@/lib/designers/repository';
import { toFullDesignerDto } from '@/lib/storefront/dto';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return runStorefront(req, async (sfCtx) => {
    const { cors } = sfCtx;
    const loc = localizeCtxFrom(sfCtx);
    const { slug } = await ctx.params;

    const designer = await getActiveDesignerBySlug(slug);
    if (!designer) {
      return jsonError('not_found', 'Дизайнер не найден.', cors);
    }

    const settings = await getEffectiveSettings();
    const storage = getStorage();
    const seoCtx = buildEntitySeoCtx(settings, (k) => storage.url(k), 'designer');
    return jsonData(toFullDesignerDto(designer, { seoCtx, loc }), {}, cors);
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
