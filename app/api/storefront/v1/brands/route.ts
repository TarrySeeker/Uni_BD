/**
 * GET /api/storefront/v1/brands — список активных брендов (ADR-008, docs/06 §6).
 * Только is_active=true; внутренние поля (logoKey, sort, даты) скрыты DTO.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { listBrands } from '@/lib/catalog/repository';
import { toFullBrandDto } from '@/lib/storefront/dto';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(req, async ({ cors }) => {
    const brands = await listBrands({ activeOnly: true });
    // SEO-контекст брендов: домен/шаблон из настроек, og:image-URL — через storage.
    const settings = await getEffectiveSettings();
    const storage = getStorage();
    const seoCtx = buildEntitySeoCtx(settings, (k) => storage.url(k), 'brand');
    return jsonData(
      brands.map((b) => toFullBrandDto(b, { seoCtx })),
      { count: brands.length },
      cors,
    );
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
