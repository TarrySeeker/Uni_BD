/**
 * GET /api/storefront/v1/products/[slug] — публичная карточка товара (ADR-008).
 *
 * Отдаёт только status='active' товар по slug: цена/скидка/новизна готовы,
 * варианты (публичные: id/sku/цена/атрибуты/inStock), медиа, бренд, категории.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { getProductById } from '@/lib/catalog/repository';
import {
  getActiveProductIdBySlug,
  getProductCategorySlugs,
} from '@/lib/storefront/queries';
import { toProductDetailDto } from '@/lib/storefront/dto';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { resolveIsNew } from '@/lib/catalog/pricing';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return runStorefront(req, async ({ cors }) => {
    const { slug } = await ctx.params;

    const id = await getActiveProductIdBySlug(slug);
    if (!id) {
      return jsonError('not_found', 'Товар не найден.', cors);
    }

    const product = await getProductById(id);
    if (!product || product.status !== 'active') {
      return jsonError('not_found', 'Товар не найден.', cors);
    }

    const categorySlugs = await getProductCategorySlugs(id);
    // «Новизна» — из эффективных настроек (env ⊕ БД), docs/11 §5.4.4.
    const settings = await getEffectiveSettings();
    const newProductDays = settings.catalog.newProductDays;
    const effectiveIsNew = resolveIsNew(
      product.isNew,
      product.createdAt,
      newProductDays,
    );

    // SEO-контекст: домен/шаблон из настроек, og:image-URL — через storage (docs/11 §5.3).
    const storage = getStorage();
    const seoCtx = buildEntitySeoCtx(settings, (k) => storage.url(k), 'product');

    const dto = toProductDetailDto(product, { effectiveIsNew, categorySlugs, seoCtx });
    return jsonData(dto, {}, cors);
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
