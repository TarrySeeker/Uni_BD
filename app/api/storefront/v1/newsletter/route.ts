/**
 * POST /api/storefront/v1/newsletter — подписка на рассылку (G-12). Раньше форма
 * в футере витрины была заглушкой и подписки терялись.
 *
 * Конвейер runStorefront: ключ/Origin → rate-limit → CORS. module:null (core).
 * Тело валидируется NewsletterInputSchema. Подписка идемпотентна (ON CONFLICT).
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { NewsletterInputSchema } from '@/lib/newsletter/schemas';
import { PdConsentSchema } from '@/lib/consent/schemas';
import { recordConsentSafe } from '@/lib/consent/repository';
import { normalizeClientIp } from '@/lib/server/request-ip';
import { z } from 'zod';

/**
 * Подписка на рассылку — это и обработка ПДн (адрес), и реклама. Основание
 * нужно обоим: ст.18 ФЗ-38 требует предварительного согласия на рекламу, и
 * доказывать его обязан распространитель.
 */
const StorefrontNewsletterSchema = z.object({
  ...NewsletterInputSchema.shape,
  consent: PdConsentSchema,
});
import { subscribe } from '@/lib/newsletter/repository';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

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
      const parsed = StorefrontNewsletterSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Укажите корректный email.', cors);
      }
      try {
        await subscribe(parsed.data.email);
        await recordConsentSafe({
          purposes: ['pd', 'marketing'],
          source: 'newsletter',
          subject: parsed.data.email,
          ip: normalizeClientIp(
            req.headers.get('x-forwarded-for'),
            req.headers.get('x-real-ip'),
          ),
          userAgent: req.headers.get('user-agent'),
        });
        return jsonData({ ok: true }, {}, cors);
      } catch (err) {
        logger.error('newsletter: не удалось сохранить подписку', {
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { module: null, methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
