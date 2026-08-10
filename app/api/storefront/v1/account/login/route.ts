/**
 * POST /api/storefront/v1/account/login — вход покупателя.
 *
 * Все причины отказа схлопнуты в один ответ: нет аккаунта, гость без пароля,
 * неверный пароль, заблокирован — снаружи неразличимы. Иначе форма входа
 * сообщала бы, зарегистрирован ли человек в магазине.
 *
 * Отдельно отвечаем только на исчерпание лимита попыток: покупателю нужно
 * понимать, что дело во временной блокировке, а не в пароле.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { LoginSchema } from '@/lib/customer/schemas';
import { loginCustomer } from '@/lib/customer/service';
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

      const parsed = LoginSchema.safeParse(body);
      if (!parsed.success) {
        // Даже здесь не уточняем, что именно не так: подсказка «такого адреса не
        // бывает» тоже сообщает лишнее.
        return jsonError('unauthorized', 'Неверный адрес или пароль.', cors);
      }

      const res = await loginCustomer(parsed.data, sessionMeta(req));

      if (!res.ok) {
        if (res.reason === 'rate_limited') {
          return jsonError('rate_limited', 'Слишком много попыток входа. Попробуйте позже.', cors);
        }
        return jsonError('unauthorized', 'Неверный адрес или пароль.', cors);
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
