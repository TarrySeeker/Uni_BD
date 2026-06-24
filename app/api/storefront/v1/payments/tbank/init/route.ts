/**
 * POST /api/storefront/v1/payments/tbank/init — инициация онлайн-оплаты Т-Банк
 * для витрины (docs/15 §4.1, ADR-010/ADR-017).
 *
 * Конвейер runStorefront: module-gate `payments` (404) → authorizeStorefront →
 * rate-limit → CORS. В mock-режиме Т-Банка (пустые TBANK_*) возвращается
 * внутренний demo-PaymentURL; в боевом — реальная платёжная ссылка из Init.
 *
 * ANTI-TAMPER (ADR-010): сумма НЕ читается из тела — Amount считает СЕРВЕР из
 * orders.grand_total в БД (service.initPayment). Доступ к заказу подтверждается
 * токеном заказа (orderAccessToken) ИЛИ email покупателя (verifyOrderAccess) —
 * анти-перебор номеров (§4.2), как GET /orders/:number.
 *
 * Body: { orderNumber, accessToken? | email? }.
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
import { PaymentService } from '@/lib/payments/tbank/service';

export const dynamic = 'force-dynamic';

const InitSchema = z
  .object({
    orderNumber: z.string().trim().min(1, 'Требуется orderNumber.'),
    accessToken: z.string().trim().optional(),
    email: z.string().trim().optional(),
    // Куда вернуть покупателя после demo-оплаты (mock-режим). Боевой Т-Банк
    // использует SuccessURL/FailURL из конфигурации — returnUrl на него не влияет.
    returnUrl: z.string().trim().url().optional(),
  })
  .strip();

/** Origin для абсолютного mock-PaymentURL (по своему ПУБЛИЧНОМУ домену, без хардкода).
 *  За реверс-прокси (Caddy) req.url несёт ВНУТРЕННИЙ origin (http://app:3000) —
 *  непригоден для редиректа браузера. Берём публичный origin из X-Forwarded-Host/
 *  Proto (их проставляет доверенный прокси), c фолбэком на req.url. */
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
      // доступа (зеркалит GET /orders/:number, §4.2) — чтобы перебор номеров не
      // отличал «нет заказа» (404) от «нет доступа» (403) и не раскрывал
      // существование/диапазон заказов (enumeration oracle). Доступ по токену
      // заказа ИЛИ email покупателя.
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
