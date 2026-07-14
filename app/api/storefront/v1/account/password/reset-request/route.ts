/**
 * POST /api/storefront/v1/account/password/reset-request — запрос сброса пароля.
 *
 * ANTI-ENUMERATION: ВСЕГДА отвечает generic 200 (существует email или нет —
 * неотличимо). Если активный аккаунт есть — сервис создаёт одноразовый токен (TTL
 * 1ч, sha256 в БД) и возвращает сырой токен ДЛЯ ПИСЬМА; роут его наружу НЕ отдаёт.
 * Гейт module:'account'. Перебор ограничен rate-limit (customer:reset:*).
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { PasswordResetRequestSchema } from '@/lib/customer-auth/schemas';
import { requestPasswordReset } from '@/lib/customer-auth/service';
import { RateLimitedError } from '@/lib/customer-auth/errors';
import { logger } from '@/lib/logger';
import { reqMeta } from '../../_helpers';

export const dynamic = 'force-dynamic';

/** Единый generic-ответ (не зависит от наличия email). */
const GENERIC = {
  message: 'Если аккаунт с таким email существует, мы отправили ссылку для сброса пароля.',
};

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = PasswordResetRequestSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        // Невалидный email — тоже generic 200 (не раскрываем существование).
        return jsonData(GENERIC, {}, cors);
      }

      try {
        const { rawToken } = await requestPasswordReset(parsed.data.email, reqMeta(req));
        // TODO(7b/email): отправить письмо со ссылкой ?token=rawToken. Сырой токен
        // НЕ возвращаем в HTTP и НЕ логируем.
        void rawToken;
      } catch (err) {
        if (err instanceof RateLimitedError) {
          return jsonError('rate_limited', 'Слишком много попыток.', cors, {
            'Retry-After': String(err.retryAfterSec),
          });
        }
        // Любую иную ошибку глушим до generic (не раскрываем внутреннее состояние),
        // но логируем без PII/токена.
        logger.error('reset-request: внутренняя ошибка', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return jsonData(GENERIC, {}, cors);
    },
    { module: 'account', methods: STOREFRONT_WRITE_METHODS, credentialed: true },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS, true);
}
