/**
 * POST /api/storefront/v1/leads — приём заявки с формы обратной связи витрины
 * (G-09). Раньше форма /contacts была заглушкой и сообщения терялись.
 *
 * Конвейер runStorefront: authorizeStorefront (ключ/Origin) → rate-limit → CORS.
 * module:null — core-always-on (приём заявок не зависит от catalog/orders). Тело
 * валидируется LeadInputSchema (длины — анти-спам/анти-tamper). Идемпотентность не
 * требуется (создание заявки), но rate-limit конвейера защищает от флуда.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { LeadInputSchema } from '@/lib/leads/schemas';
import { insertLead } from '@/lib/leads/repository';
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
      const parsed = LeadInputSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля формы.', cors);
      }
      try {
        const { id } = await insertLead({
          name: parsed.data.name,
          contact: parsed.data.contact,
          message: parsed.data.message,
          source: 'contact_form',
        });
        return jsonData({ id }, {}, cors);
      } catch (err) {
        // Сбой записи — пробрасываем: runStorefront завернёт в нейтральный 500.
        logger.error('lead submit: не удалось сохранить заявку', {
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
