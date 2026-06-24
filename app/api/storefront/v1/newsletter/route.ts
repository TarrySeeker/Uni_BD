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
      const parsed = NewsletterInputSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Укажите корректный email.', cors);
      }
      try {
        await subscribe(parsed.data.email);
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
