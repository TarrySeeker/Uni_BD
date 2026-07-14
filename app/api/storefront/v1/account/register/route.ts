/**
 * POST /api/storefront/v1/account/register — регистрация покупателя (docs/24 §6).
 *
 * Гейт module:'account' (выключен → 404). runStorefront: storefront-rate-limit +
 * CORS. Внутри — СВОЙ login-rate-limit ядра (customer:register:ip). Занятый
 * активный email → generic 409 (без утечки «email существует»). Успех → сессия
 * (cookie + Bearer-токен в теле), 201.
 */

import {
  runStorefront,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { RegisterSchema } from '@/lib/customer-auth/schemas';
import { register, RegistrationFailedError } from '@/lib/customer-auth/service';
import { RateLimitedError } from '@/lib/customer-auth/errors';
import { reqMeta, authResponse } from '../_helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors, locale }) => {
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = RegisterSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля регистрации.', cors);
      }

      try {
        const result = await register(
          {
            email: parsed.data.email,
            password: parsed.data.password,
            name: parsed.data.name ?? '',
            // Локаль из тела ИЛИ эффективная locale запроса (ctx.locale).
            preferredLocale: parsed.data.preferredLocale ?? locale,
          },
          reqMeta(req),
        );
        return authResponse(result, cors, 201);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return jsonError('rate_limited', 'Слишком много попыток.', cors, {
            'Retry-After': String(err.retryAfterSec),
          });
        }
        if (err instanceof RegistrationFailedError) {
          // Anti-enumeration: не раскрываем, что email занят.
          return jsonError(
            'conflict',
            'Не удалось зарегистрировать аккаунт. Возможно, он уже существует — войдите или восстановите пароль.',
            cors,
          );
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
