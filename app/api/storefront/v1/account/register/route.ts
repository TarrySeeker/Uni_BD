/**
 * POST /api/storefront/v1/account/register — регистрация покупателя.
 *
 * Ответ НЕ различает «адрес свободен» и «адрес занят»: сообщение «такой email
 * уже зарегистрирован» — это готовая проверялка чужой клиентской базы. Причину
 * отказа знает сервис, наружу она не выносится.
 *
 * Токен сессии возвращается в теле, а не ставится cookie: cookie ставит витрина
 * на своём домене (httpOnly), а API остаётся не привязанным к домену и одинаково
 * работает и со статической витриной, и с рендерящейся на сервере.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { RegisterSchema } from '@/lib/customer/schemas';
import { registerCustomer } from '@/lib/customer/service';
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

      const parsed = RegisterSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля формы.', cors);
      }

      const res = await registerCustomer(parsed.data, sessionMeta(req));

      if (!res.ok) {
        if (res.reason === 'rate_limited') {
          return jsonError('rate_limited', 'Слишком много попыток. Попробуйте позже.', cors);
        }
        // Намеренно обезличенный текст: он одинаков и для занятого адреса, и для
        // любой другой неудачи регистрации.
        return jsonError(
          'unprocessable',
          'Не удалось создать аккаунт. Проверьте данные или войдите, если аккаунт уже есть.',
          cors,
        );
      }

      return jsonData(
        {
          customer: res.customer,
          session: { token: res.session.token, expiresAt: res.session.expiresAt.toISOString() },
        },
        {},
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
