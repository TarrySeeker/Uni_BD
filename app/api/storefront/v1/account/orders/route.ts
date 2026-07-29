/**
 * GET /api/storefront/v1/account/orders — история заказов покупателя (docs/24 §6).
 *
 * Требует валидной сессии (401 иначе). Возвращает СВОДКИ заказов авторизованного
 * покупателя (по customer_id). accessToken заказов НЕ отдаётся. Гейт module:'account'.
 *
 * ГРАНИЦА 7a: только ЧТЕНИЕ orders. Заполнение orders.customer_id (createOrder) и
 * бэкофилл гостевых заказов — 7b; сейчас список может быть пуст, пока связка не
 * подключена. Роут корректен независимо от этого.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
} from '@/lib/storefront/response';
import { STOREFRONT_METHODS } from '@/lib/storefront/cors';
import { extractCustomerSessionToken } from '@/lib/customer-auth/cookies';
import { getMe, getOrderHistory } from '@/lib/customer-auth/service';
import { toCustomerOrderDto } from '@/lib/storefront/account-dto';

export const dynamic = 'force-dynamic';

function parseIntOr(v: string | null, def: number): number {
  if (v === null) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors, locale }) => {
      const customer = await getMe(extractCustomerSessionToken(req));
      if (!customer) {
        return jsonError('unauthorized', 'Требуется вход.', cors);
      }

      const q = new URL(req.url).searchParams;
      const page = Math.max(1, parseIntOr(q.get('page'), 1));
      const pageSize = Math.min(50, Math.max(1, parseIntOr(q.get('pageSize'), 20)));
      const offset = (page - 1) * pageSize;

      const orders = await getOrderHistory(customer.id, { limit: pageSize, offset });
      // Подписи статусов — на языке ПОКУПАТЕЛЯ (minor №6): локаль уже вычислена
      // runStorefront, раньше она здесь терялась и ЛК был русским для en/fr.
      const items = orders.map((o) => toCustomerOrderDto(o, locale));

      return jsonData(
        { items },
        { pagination: { page, pageSize, count: items.length } },
        cors,
      );
    },
    { module: 'account', methods: STOREFRONT_METHODS, credentialed: true },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_METHODS, true);
}
