/**
 * GET /api/storefront/v1/designers — список активных дизайнеров (§9, ADR §4.4).
 * Только is_active=true; внутренние поля (ключи S3, sort, даты) скрыты DTO.
 * Переводимые поля (name/description/country) резолвятся по ctx.locale.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { listDesigners } from '@/lib/designers/repository';
import { toFullDesignerDto } from '@/lib/storefront/dto';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(req, async (ctx) => {
    const { cors } = ctx;
    const loc = localizeCtxFrom(ctx);
    const designers = await listDesigners({ activeOnly: true });
    const settings = await getEffectiveSettings();
    const storage = getStorage();
    const seoCtx = buildEntitySeoCtx(settings, (k) => storage.url(k), 'designer');
    return jsonData(
      designers.map((d) => toFullDesignerDto(d, { seoCtx, loc })),
      { count: designers.length },
      cors,
    );
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
