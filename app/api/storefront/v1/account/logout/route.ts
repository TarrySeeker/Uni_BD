/**
 * POST /api/storefront/v1/account/logout — выход покупателя.
 *
 * Идемпотентен: выход без действующей сессии — это успех, а не ошибка. Кнопка
 * «выйти» обязана срабатывать всегда, в том числе когда сессия уже истекла или
 * была закрыта на другом устройстве. Отвечать здесь «не авторизован» значило бы
 * оставлять покупателя на странице, с которой он не может уйти.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { extractCustomerSessionToken } from '@/lib/customer/require-customer';
import { invalidateCustomerSession } from '@/lib/customer/session';
import { ACCOUNT_METHODS } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const token = extractCustomerSessionToken(req.headers);
      if (token) {
        await invalidateCustomerSession(token);
      }
      return jsonData({ ok: true }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
