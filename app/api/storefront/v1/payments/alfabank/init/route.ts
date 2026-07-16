/**
 * POST /api/storefront/v1/payments/alfabank/init — инициация онлайн-оплаты
 * Альфа-Банка для витрины (ADR-010/ADR-017; зеркало paykeeper/init и tbank/init).
 *
 * Конвейер runStorefront: module-gate `payments` (404) → authorizeStorefront →
 * rate-limit → CORS. В mock-режиме Альфа-Банка (пустые ALFABANK_USERNAME/PASSWORD)
 * возвращается внутренний demo-URL; в боевом — реальная платёжная ссылка (formUrl).
 *
 * ANTI-TAMPER (ADR-010): сумма НЕ читается из тела — amount считает СЕРВЕР из
 * orders.grand_total в БД (service.initPayment, в КОПЕЙКАХ). Доступ к заказу
 * подтверждается токеном заказа ИЛИ email покупателя (verifyOrderAccess).
 *
 * Body: { orderNumber, accessToken? | email? , returnUrl? }.
 * Ответ: { data: { paymentUrl, paymentId, status, isMock } }.
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
import { PaymentService } from '@/lib/payments/alfabank/service';

export const dynamic = 'force-dynamic';

const InitSchema = z
  .object({
    orderNumber: z.string().trim().min(1, 'Требуется orderNumber.'),
    accessToken: z.string().trim().optional(),
    email: z.string().trim().optional(),
    // Куда вернуть покупателя после оплаты (register.do returnUrl). В mock прокидывается
    // в demo-URL; в боевом — используется как returnUrl регистрации заказа.
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
            paymentId: res.paymentId,
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
