/**
 * POST /api/storefront/v1/account/email/confirm-verify — подтверждение владения
 * email (docs/24 §6, шаг 7b).
 *
 * Погашает ОДНОРАЗОВЫЙ токен (purpose='email_verify', с учётом expiry), ставит
 * customers.email_verified_at и привязывает прошлые ГОСТЕВЫЕ заказы того же email к
 * аккаунту (linkGuestOrdersByEmail — atomic/идемпотентно). Недействительный/
 * истёкший/использованный токен → generic 400 (без деталей). Гейт module:'account'.
 * По образцу reset-confirm.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { EmailVerifyConfirmSchema } from '@/lib/customer-auth/schemas';
import { confirmEmailVerification } from '@/lib/customer-auth/service';
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
      const parsed = EmailVerifyConfirmSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте ссылку подтверждения.', cors);
      }

      try {
        const { linkedOrders } = await confirmEmailVerification(parsed.data.token, reqMeta(req));
        return jsonData(
          { message: 'Email подтверждён.', linkedOrders },
          {},
          cors,
        );
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
