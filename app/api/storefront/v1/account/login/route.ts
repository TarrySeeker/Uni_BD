/**
 * POST /api/storefront/v1/account/login — вход покупателя (docs/24 §6).
 *
 * Гейт module:'account'. ЕДИНЫЙ 401 на любой отказ (нет аккаунта/неверный пароль/
 * disabled) — anti-enumeration; verifyDummy в сервисе выравнивает время. Успех →
 * сессия (cookie + Bearer-токен), 200.
 */

import {
  runStorefront,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { LoginSchema } from '@/lib/customer-auth/schemas';
import { login } from '@/lib/customer-auth/service';
import { InvalidCredentialsError, RateLimitedError } from '@/lib/customer-auth/errors';
import { reqMeta, authResponse } from '../_helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = LoginSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        // Даже структурную ошибку отдаём как единый 401 (не подсказываем формат).
        return jsonError('unauthorized', 'Неверный email или пароль.', cors);
      }

      try {
        const result = await login(
          { email: parsed.data.email, password: parsed.data.password },
          reqMeta(req),
        );
        return authResponse(result, cors, 200);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return jsonError('rate_limited', 'Слишком много попыток.', cors, {
            'Retry-After': String(err.retryAfterSec),
          });
        }
        if (err instanceof InvalidCredentialsError) {
          return jsonError('unauthorized', 'Неверный email или пароль.', cors);
        }
        throw err;
      }
    },
    { module: 'account', methods: STOREFRONT_WRITE_METHODS, credentialed: true },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS, true);
}
