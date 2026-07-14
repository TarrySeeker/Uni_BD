/**
 * GET /api/storefront/v1/categories — дерево категорий (ADR-008, docs/06 §6).
 * Отдаёт только активные ветви (toCategoryTreeDto скрывает is_active=false).
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getCategoryTree } from '@/lib/catalog/repository';
import { toCategoryTreeDto } from '@/lib/storefront/dto';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(req, async (ctx) => {
    const { cors } = ctx;
    const loc = localizeCtxFrom(ctx);
    // storage.url резолвит image_key категории → публичный URL (сырой S3-ключ
    // наружу не отдаём, зеркально бренду/медиа, §9).
    const storage = getStorage();
    const tree = await getCategoryTree();
    return jsonData(toCategoryTreeDto(tree, loc, (k) => storage.url(k)), {}, cors);
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
