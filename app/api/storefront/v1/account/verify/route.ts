/**
 * POST /api/storefront/v1/account/verify — подтверждение адреса почты по ссылке.
 *
 * 🔴 Это ЕДИНСТВЕННОЕ место, где к аккаунту привязываются заказы, оформленные
 * ранее гостем на тот же адрес. Соблазн сделать это при регистрации велик, но
 * тогда достаточно зарегистрироваться на чужой email, чтобы получить чужие
 * заказы: адреса доставки, телефоны, состав покупок. Регистрация владения
 * адресом не доказывает — доказывает переход по ссылке из письма.
 *
 * Роут намеренно НЕ требует входа: покупатель может открыть ссылку в другом
 * браузере, где сессии нет. Токен сам по себе является учётными данными.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { TokenSchema } from '@/lib/customer/schemas';
import { confirmEmailVerification } from '@/lib/customer/service';
import { ACCOUNT_METHODS, sessionMeta } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }

      const parsed = TokenSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Не указана ссылка подтверждения.', cors);
      }

      const res = await confirmEmailVerification(parsed.data.token, sessionMeta(req));
      if (!res.ok) {
        return jsonError(
          'unauthorized',
          'Ссылка недействительна или устарела. Запросите письмо повторно из личного кабинета.',
          cors,
        );
      }

      // Число привязанных заказов показываем: покупателю полезно понимать, что
      // именно изменилось после подтверждения.
      return jsonData({ ok: true, linkedOrders: res.linkedOrders }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
