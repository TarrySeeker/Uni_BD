/**
 * PATCH /api/storefront/v1/account/password — смена пароля изнутри кабинета.
 *
 * Требует текущий пароль: одной действующей сессии недостаточно. Иначе угнанная
 * сессия позволяла бы сменить пароль и запереть владельца снаружи собственного
 * аккаунта — а это худший исход, чем сам угон.
 *
 * После смены все прежние сессии закрываются, и вызывающему возвращается НОВЫЙ
 * токен: инициатор остаётся в кабинете, прочие устройства выходят. Витрина
 * обязана заменить сохранённый токен этим — иначе покупатель разлогинится сам.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { ChangePasswordSchema } from '@/lib/customer/schemas';
import { changeCustomerPassword } from '@/lib/customer/service';
import { ACCOUNT_METHODS, requireCustomer, sessionMeta } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function PATCH(req: Request): Promise<Response> {
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

      const parsed = ChangePasswordSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(
          'unprocessable',
          'Проверьте поля: новый пароль должен быть не короче 8 символов.',
          cors,
        );
      }

      const res = await changeCustomerPassword(who.id, parsed.data, sessionMeta(req));
      if (!res.ok) {
        // Здесь сообщить «текущий пароль неверен» безопасно: покупатель уже
        // вошёл, и никакой информации о чужих аккаунтах ответ не раскрывает.
        return jsonError('unauthorized', 'Текущий пароль указан неверно.', cors);
      }

      return jsonData(
        { session: { token: res.session.token, expiresAt: res.session.expiresAt.toISOString() } },
        {},
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
