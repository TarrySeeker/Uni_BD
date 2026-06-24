/**
 * GET /api/storefront/v1/products — публичный список товаров (ADR-008, docs/06 §6).
 *
 * Query: q (поиск), brand (slug? — нет; здесь brandId через ?brandId), category
 * (categoryId), featured, new, sale (булевы фасеты), limit/offset (пагинация).
 * Отдаёт только status='active' товары. Цены/скидки — готовые из pricing.
 */

import { z } from 'zod';
import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { listProducts } from '@/lib/catalog/repository';
import type { ProductListFilter } from '@/lib/catalog/repository';
import { getActiveCategoryIdBySlug } from '@/lib/storefront/queries';
import { toProductListItemDto } from '@/lib/storefront/dto';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

// brandId/categoryId уходят в SQL с ::uuid-кастом (listProducts). Это ТОЧНЫЕ
// id-фильтры (не поиск): не-UUID значение — ошибка клиента → 400, а НЕ 500 на
// uuid-cast в БД (BUG #6, reliability). Валидируем ДО запроса.
const uuidParam = z.string().uuid();

function parseBool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  return undefined;
}

function parseIntOr(v: string | null, def: number): number {
  if (v === null) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(req, async ({ cors }) => {
    const url = new URL(req.url);
    const q = url.searchParams;

    const limit = Math.min(100, Math.max(1, parseIntOr(q.get('limit'), 24)));
    // offset пробрасывается в listProducts КАК ЕСТЬ (clamp >= 0), без округления
    // до границы страницы. Свободный offset (не кратный limit) не должен молча
    // терять/дублировать товары между «страницами» (BUG: minor пагинации).
    const offset = Math.max(0, parseIntOr(q.get('offset'), 0));
    // page оставляем совместимым (фолбэк/логи), но offset имеет приоритет в SQL.
    const page = Math.floor(offset / limit) + 1;

    // brandId — точный id-фильтр: если задан, обязан быть валидным uuid, иначе
    // 400 (не доводим мусор до ::uuid-каста в БД → 500). Отсутствие — ok.
    // ПУСТАЯ строка (`brandId=`) трактуется как отсутствие (фронт часто шлёт
    // `brandId=${sel||''}`): trim()||null → null, иначе 400 был бы ложным.
    const brandIdRaw = q.get('brandId')?.trim() || null;
    if (brandIdRaw !== null && !uuidParam.safeParse(brandIdRaw).success) {
      return jsonError('bad_request', 'Параметр brandId должен быть корректным UUID.', cors);
    }

    // Категория может прийти как categoryId (uuid) или как category (slug).
    // Slug удобнее витрине (она знает дерево /categories по slug). Явный
    // categoryId имеет приоритет; иначе резолвим slug → id (нет такой → пусто).
    // ПУСТАЯ строка (`categoryId=`) → undefined, чтобы не отвергнуть запрос с
    // валидным slug-параметром `category=` (типичный `categoryId=${sel||''}`):
    // тогда сработает резолв slug ниже, а не 400.
    let categoryId = q.get('categoryId')?.trim() || undefined;
    // categoryId — тоже точный id-фильтр: задан (непустой) и не uuid → 400 (как brandId).
    if (categoryId !== undefined && !uuidParam.safeParse(categoryId).success) {
      return jsonError('bad_request', 'Параметр categoryId должен быть корректным UUID.', cors);
    }
    const categorySlug = q.get('category')?.trim();
    if (!categoryId && categorySlug) {
      // Нет такой категории → nil-uuid: валиден для ::uuid-каста, не матчит ничего.
      categoryId =
        (await getActiveCategoryIdBySlug(categorySlug)) ??
        '00000000-0000-0000-0000-000000000000';
    }

    const filter: ProductListFilter = {
      search: q.get('q') ?? undefined,
      // Витрине отдаём только опубликованные товары.
      status: 'active',
      brandId: brandIdRaw ?? undefined,
      categoryId,
      isFeatured: parseBool(q.get('featured')),
      isNew: parseBool(q.get('new')),
      onSale: parseBool(q.get('sale')),
      page,
      // Явный offset (приоритет над page в listProducts) — точная пагинация.
      offset,
      pageSize: limit,
    };

    const { rows, total } = await listProducts(filter);
    // Логотип бренда: ключ → публичный URL через storage.url (как og:image/медиа).
    const storage = getStorage();
    const data = rows.map((r) => toProductListItemDto(r, (k) => storage.url(k)));

    return jsonData(
      data,
      { pagination: { total, limit, offset, count: data.length } },
      cors,
    );
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
