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
import { PdConsentSchema } from '@/lib/consent/schemas';
import { recordConsentSafe } from '@/lib/consent/repository';
import { normalizeClientIp } from '@/lib/server/request-ip';
import { z } from 'zod';

/**
 * Форма обратной связи собирает имя и контакт — это персональные данные, и у
 * их обработки должно быть основание (152-ФЗ). Проверять только чекаут
 * недостаточно: на бою форма обратной связи собирала контакты вообще без
 * согласия (docs/32 §8-bis).
 *
 * Согласие добавлено НА УРОВНЕ РОУТА, а не в LeadInputSchema: сама схема
 * описывает заявку как сущность и переиспользуется внутренними путями, где
 * галочек нет.
 */
const StorefrontLeadSchema = z.object({
  ...LeadInputSchema.shape,
  consent: PdConsentSchema,
});
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
      const parsed = StorefrontLeadSchema.safeParse(body);
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
        await recordConsentSafe({
          purposes: ['pd'],
          source: 'lead',
          sourceRef: id,
          subject: parsed.data.contact,
          ip: normalizeClientIp(
            req.headers.get('x-forwarded-for'),
            req.headers.get('x-real-ip'),
          ),
          userAgent: req.headers.get('user-agent'),
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
