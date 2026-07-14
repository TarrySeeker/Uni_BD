/**
 * POST /api/storefront/v1/account/password/reset-confirm — подтверждение сброса.
 *
 * Погашает ОДНОРАЗОВЫЙ токен, ставит новый пароль, ИНВАЛИДИРУЕТ ВСЕ сессии
 * покупателя (выход со всех устройств). Недействительный/истёкший/использованный
 * токен → generic 400 (без деталей). Гейт module:'account'.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { PasswordResetConfirmSchema } from '@/lib/customer-auth/schemas';
import { confirmPasswordReset } from '@/lib/customer-auth/service';
import { InvalidTokenError, RateLimitedError } from '@/lib/customer-auth/errors';
import { reqMeta } from '../../_helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = PasswordResetConfirmSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте токен и новый пароль.', cors);
      }

      try {
        await confirmPasswordReset(parsed.data.token, parsed.data.password, reqMeta(req));
        return jsonData({ message: 'Пароль обновлён. Войдите с новым паролем.' }, {}, cors);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return jsonError('rate_limited', 'Слишком много попыток.', cors, {
            'Retry-After': String(err.retryAfterSec),
          });
        }
        if (err instanceof InvalidTokenError) {
          return jsonError(
            'bad_request',
            'Ссылка недействительна или срок её действия истёк.',
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
