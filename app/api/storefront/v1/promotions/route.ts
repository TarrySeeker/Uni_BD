/**
 * GET /api/storefront/v1/promotions — публичный список активных акций для бейджей
 * «3 по 2» / «−10% на бренд X» (docs/11 §5.2.4, ADR-014). Read-only. Конвейер:
 * authorizeStorefront → модуль `orders` (иначе 404) → rate-limit → CORS.
 *
 * Отдаёт ТОЛЬКО публично-безопасные поля (toPublicPromotionDto): publicLabel
 * (БЕЗОПАСНАЯ маркетинговая метка, НЕ секретный код — m6), kind, applyScope,
 * bogoBuyQty/bogoPayQty, target*Slugs, activeFrom/activeTo. СКРЫВАЕТ сам код промокода
 * и usageLimit/usedCount/perCustomerLimit/comment/id (анти-утечка, как dto.ts каталога).
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_METHODS } from '@/lib/storefront/cors';
import { listActivePromotions } from '@/lib/orders/repository';
import { toPublicPromotionDto } from '@/lib/storefront/order-dto';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const active = await listActivePromotions();
      const data = active.map((a) =>
        toPublicPromotionDto({
          promo: a.promo,
          targetCategorySlugs: a.targetCategorySlugs,
          targetBrandSlugs: a.targetBrandSlugs,
        }),
      );
      return jsonData(data, { count: data.length }, cors);
    },
    { module: 'orders' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_METHODS);
}
