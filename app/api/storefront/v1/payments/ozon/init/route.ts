/**
 * POST /api/storefront/v1/payments/ozon/init — инициация оплаты Ozon для витрины
 * (порт роута payments/tbank/init).
 *
 * Конвейер runStorefront: module-gate `payments` (404) → authorizeStorefront →
 * rate-limit → CORS.
 *
 * ANTI-TAMPER: сумма НЕ читается из тела — её считает сервер из orders.grand_total
 * (см. OzonPaymentService.initPayment). Доступ к заказу подтверждается токеном
 * заказа или email покупателя: единый ответ «не найдено» и для несуществующего,
 * и для чужого заказа, чтобы перебор номеров не различал эти случаи.
 *
 * Body: { orderNumber, accessToken? | email?, returnUrl? }.
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
import { OzonPaymentService } from '@/lib/payments/ozon/service';

export const dynamic = 'force-dynamic';

const InitSchema = z
  .object({
    orderNumber: z.string().trim().min(1, 'Требуется orderNumber.'),
    accessToken: z.string().trim().optional(),
    email: z.string().trim().optional(),
    // Куда вернуть покупателя после demo-оплаты (mock-режим). В боевом режиме
    // адреса возврата берутся из настроек токена / конфигурации.
    returnUrl: z.string().trim().url().optional(),
  })
  .strip();

/**
 * Публичный origin запроса. За обратным прокси req.url несёт внутренний адрес
 * (http://app:3000), непригодный для редиректа браузера, поэтому берём
 * X-Forwarded-Host/Proto, которые проставляет доверенный прокси.
 */
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

      // Единый ответ «не найдено» и для несуществующего заказа, и для отказа
      // в доступе — иначе перебор номеров отличал бы «нет заказа» от «чужой
      // заказ» и раскрывал существование заказов.
      if (!found || !verifyOrderAccess(found.order, { token: accessToken, email })) {
        return jsonError('not_found', 'Заказ не найден.', cors);
      }

      // Уже оплачен или возвращён — повторная инициация бессмысленна и опасна.
      if (found.order.paymentStatus === 'paid' || found.order.paymentStatus === 'refunded') {
        return jsonError(
          'conflict',
          `Заказ уже в статусе оплаты «${found.order.paymentStatus}».`,
          cors,
        );
      }

      try {
        const res = await new OzonPaymentService().initPayment(found.order, found.items, {
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
