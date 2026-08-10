/**
 * GET    /api/storefront/v1/account/wishlist — избранное покупателя.
 * POST   /api/storefront/v1/account/wishlist — добавить товар.
 * DELETE /api/storefront/v1/account/wishlist — убрать товар.
 *
 * Товар адресуется публичным `slug`, а не внутренним идентификатором: наружу
 * идентификаторы каталога не отдаются вовсе, поэтому и приходить они не могут.
 *
 * Карточки для списка собираются обычным путём каталога — с ценой, скидкой и
 * наличием. Избранное не должно показывать устаревшие данные: цена в нём обязана
 * совпадать с ценой в каталоге.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { WishlistItemSchema } from '@/lib/customer/schemas';
import {
  listWishlistProductIds,
  addWishlist,
  removeWishlist,
  findProductIdBySlug,
} from '@/lib/customer/repository';
import { listProducts } from '@/lib/catalog/repository';
import { toProductListItemDto } from '@/lib/storefront/dto';
import { ACCOUNT_METHODS, requireCustomer } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * Порция выборки товаров.
 *
 * Каталог ограничивает страницу двумя сотнями. Запросив избранное одним
 * запросом, при большем количестве мы получили бы МОЛЧА обрезанный список: без
 * ошибки, просто часть товаров исчезала бы из кабинета. Поэтому читаем частями.
 */
const CHUNK = 200;

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      const ids = await listWishlistProductIds(who.id);
      if (ids.length === 0) {
        return jsonData({ items: [] }, {}, cors);
      }

      // Порядок избранного (сначала добавленные позже) задан списком; выборка
      // каталога сортируется по своим правилам, поэтому восстанавливаем его сами.
      const order = new Map(ids.map((id, index) => [id, index]));
      const found: { id: string; item: ReturnType<typeof toProductListItemDto> }[] = [];

      for (let i = 0; i < ids.length; i += CHUNK) {
        const { rows } = await listProducts({
          ids: ids.slice(i, i + CHUNK),
          status: 'active',
          page: 1,
          pageSize: CHUNK,
        });
        found.push(...rows.map((row) => ({ id: row.id, item: toProductListItemDto(row) })));
      }

      // Снятые с публикации товары в список не попадают — покупатель не должен
      // видеть в избранном то, что нельзя купить.
      found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

      return jsonData({ items: found.map((f) => f.item) }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }

      const parsed = WishlistItemSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Не указан товар.', cors);
      }

      const productId = await findProductIdBySlug(parsed.data.slug);
      if (!productId) {
        return jsonError('not_found', 'Товар не найден.', cors);
      }

      // Повторное добавление — обычное действие покупателя, а не ошибка.
      await addWishlist(who.id, productId);
      return jsonData({ ok: true }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}

export async function DELETE(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }

      const parsed = WishlistItemSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Не указан товар.', cors);
      }

      const productId = await findProductIdBySlug(parsed.data.slug);
      // Товар мог быть удалён из каталога — для покупателя это всё равно
      // «убрано из избранного», а не ошибка.
      if (productId) {
        await removeWishlist(who.id, productId);
      }

      return jsonData({ ok: true }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
