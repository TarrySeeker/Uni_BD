/**
 * POST /api/storefront/v1/payments/paykeeper/init — инициация онлайн-оплаты
 * PayKeeper для витрины (docs/24 §2, ADR-010/ADR-017; зеркало tbank/init).
 *
 * Конвейер runStorefront: module-gate `payments` (404) → authorizeStorefront →
 * rate-limit → CORS. В mock-режиме PayKeeper (пустые PAYKEEPER_LOGIN/PASSWORD)
 * возвращается внутренний demo-URL; в боевом — реальная платёжная ссылка (invoice_url).
 *
 * ANTI-TAMPER (ADR-010): сумма НЕ читается из тела — pay_amount считает СЕРВЕР из
 * orders.grand_total в БД (service.initPayment, в РУБЛЯХ). Доступ к заказу
 * подтверждается токеном заказа ИЛИ email покупателя (verifyOrderAccess) —
 * анти-перебор номеров, как GET /orders/:number.
 *
 * Body: { orderNumber, accessToken? | email? , returnUrl? }.
 * Ответ: { data: { paymentUrl, invoiceId, status, isMock } }.
 */

import { z } from 'zod';
import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { getOrderByNumber } from '@/lib/orders/repository';
import { verifyOrderAccess } from '@/lib/storefront/order-dto';
import { PaymentService } from '@/lib/payments/paykeeper/service';

export const dynamic = 'force-dynamic';

const InitSchema = z
  .object({
    orderNumber: z.string().trim().min(1, 'Требуется orderNumber.'),
    accessToken: z.string().trim().optional(),
    email: z.string().trim().optional(),
    // Куда вернуть покупателя после demo-оплаты (mock-режим). Боевой PayKeeper
    // возвращает по настройкам ЛК — returnUrl на него не влияет.
    returnUrl: z.string().trim().url().optional(),
  })
  .strip();

/** Origin для абсолютного mock-URL (по своему ПУБЛИЧНОМУ домену, без хардкода). */
function requestOrigin(req: Request): string | undefined {
  const host = req.headers.get('x-forwarded-host');
  if (host) {
    const proto = (req.headers.get('x-forwarded-proto') ?? 'https').split(',')[0]!.trim();
    return `${proto}://${host.split(',')[0]!.trim()}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        return jsonError('bad_request', 'Тело запроса не является валидным JSON.', cors);
      }

      const parsed = InitSchema.safeParse(body.value);
      if (!parsed.success) {
        return jsonError(
          'bad_request',
          parsed.error.issues[0]?.message ?? 'Некорректное тело запроса.',
          cors,
        );
      }

      const { orderNumber, accessToken, email, returnUrl } = parsed.data;

      const found = await getOrderByNumber(orderNumber);

      // Единый ответ «не найдено» для несуществующего И для неавторизованного
      // доступа (зеркалит GET /orders/:number) — чтобы перебор номеров не отличал
      // «нет заказа» от «нет доступа».
      if (!found || !verifyOrderAccess(found.order, { token: accessToken, email })) {
        return jsonError('not_found', 'Заказ не найден.', cors);
      }

      // Уже оплачен/возвращён — повторная инициация бессмысленна.
      if (found.order.paymentStatus === 'paid' || found.order.paymentStatus === 'refunded') {
        return jsonError(
          'conflict',
          `Заказ уже в статусе оплаты «${found.order.paymentStatus}».`,
          cors,
        );
      }

      try {
        const res = await new PaymentService().initPayment(found.order, found.items, {
          baseOrigin: requestOrigin(req),
          returnUrl,
        });
        return jsonData(
          {
            paymentUrl: res.paymentUrl,
            invoiceId: res.invoiceId,
            status: res.status,
            isMock: res.isMock,
          },
          {},
          cors,
        );
      } catch {
        return jsonError('unprocessable', 'Не удалось инициировать оплату.', cors);
      }
    },
    { module: 'payments', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
