/**
 * GET /api/storefront/v1/categories — дерево категорий (ADR-008, docs/06 §6).
 * Отдаёт только активные ветви (toCategoryTreeDto скрывает is_active=false).
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getCategoryTree } from '@/lib/catalog/repository';
import { toCategoryTreeDto } from '@/lib/storefront/dto';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(req, async ({ cors }) => {
    const tree = await getCategoryTree();
    return jsonData(toCategoryTreeDto(tree), {}, cors);
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
