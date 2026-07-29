/**
 * GET /api/storefront/v1/orders/:number — публичный статус заказа для ЛК/трекинга
 * витрины (docs/07 §4.2). Конвейер: authorizeStorefront → модуль `orders` (иначе
 * 404) → rate-limit → CORS.
 *
 * ANTI-ENUMERATION (§4.2): заказ отдаётся ТОЛЬКО при подтверждении доступа —
 * ?token=<accessToken> (из ответа POST /orders) ИЛИ ?email=<email покупателя>.
 * Неверное/отсутствующее подтверждение → 404 (не раскрываем существование заказа).
 *
 * ДВА УРОВНЯ ДОСТУПА. Email — слабое подтверждение (номера последовательны, email
 * часто известен), поэтому под ним отдаётся только трекинг: статусы, город, суммы,
 * позиции, трек. ЧУВСТВИТЕЛЬНЫЕ поля (адрес доставки, пункт выдачи — физическое
 * место покупателя) требуют СИЛЬНОГО подтверждения: HMAC-токена заказа. См.
 * SENSITIVE_DELIVERY_FIELDS в lib/storefront/order-dto.ts.
 *
 * Ответ: публичный DTO (номер, статусы заказа/оплаты/доставки, позиции-снимок,
 * суммы, трек). Без ip/idempotency_key/внутренних id (order-dto не отдаёт).
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { getOrderByNumber } from '@/lib/orders/repository';
import { toOrderPublicDto, verifyOrderAccess } from '@/lib/storefront/order-dto';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ number: string }> },
): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors, locale }) => {
      const { number } = await ctx.params;
      const url = new URL(req.url);
      const token = url.searchParams.get('token');
      const email = url.searchParams.get('email');

      const found = await getOrderByNumber(number);

      // Единый ответ «не найдено» для несуществующего И для неавторизованного
      // доступа — чтобы перебор номеров не отличал «нет заказа» от «нет доступа».
      if (!found || !verifyOrderAccess(found.order, { token, email })) {
        return jsonError('not_found', 'Заказ не найден.', cors);
      }

      // Чувствительные поля доставки (адрес покупателя, пункт выдачи) — ТОЛЬКО по
      // СИЛЬНОМУ подтверждению, то есть по HMAC-токену заказа. Email-путь слабый:
      // номера последовательны, email известен → перебором утекал бы физический
      // адрес человека. Тот же приём, что у кодов сертификатов (allowEmail:false).
      const tokenProven = verifyOrderAccess(found.order, { token }, process.env, {
        allowEmail: false,
      });

      // Подписи статусов — на языке ПОКУПАТЕЛЯ (runStorefront уже вычислил его из
      // ?locale=/Accept-Language). Раньше локаль здесь молча терялась, и покупатель
      // на /en и /fr видел русские «Отгружен»/«Оплачена» (аудит major №5, №30).
      const dto = toOrderPublicDto(found.order, found.items, {
        includeSensitiveDelivery: tokenProven,
        locale,
      });
      return jsonData(dto, {}, cors);
    },
    { module: 'orders', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
