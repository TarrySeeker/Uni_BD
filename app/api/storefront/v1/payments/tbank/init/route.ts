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
  jsonDomainError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { getOrderByNumber } from '@/lib/orders/repository';
import { paymentBlockFor } from '@/lib/orders/status';
import { reasonForPaymentBlock } from '@/lib/storefront/error-reasons';
import { orderAccessToken, verifyOrderAccess } from '@/lib/storefront/order-dto';
import { PaymentService } from '@/lib/payments/tbank/service';
import { resolveOrderReturnUrl } from '@/lib/payments/return-url';
import { resolveMockPageOrigin } from '@/lib/payments/app-origin';

export const dynamic = 'force-dynamic';

const InitSchema = z
  .object({
    orderNumber: z.string().trim().min(1, 'Требуется orderNumber.'),
    accessToken: z.string().trim().optional(),
    email: z.string().trim().optional(),
    // Куда вернуть покупателя после оплаты. НЕДОВЕРЕННОЕ значение: из него берётся
    // ТОЛЬКО безопасный путь (локаль витрины) — origin и параметры заказа подставляет
    // сервер из настроек магазина (см. resolveOrderReturnUrl).
    returnUrl: z.string().trim().url().optional(),
  })
  .strip();

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
        // Доменная причина рядом с транспортным 404 (аудит №3/№6): витрина
        // выбирает свой перевод, а не печатает серверную русскую строку.
        return jsonError('not_found', 'Заказ не найден.', cors, {}, 'order_not_found');
      }

      // Оплатить можно только ЖИВОЙ заказ, по которому НЕТ денег покупателя. Тот же
      // инвариант, что в service.initPayment (paymentBlockFor) — но проверить его
      // ОБЯЗАН и роут: init-эндпоинт публичный, запрос шлётся и мимо витрины.
      // 🔴 Кроме отменённого/возвращённого заказа и уже оплаченного/возвращённого
      // платежа гард отсекает ХОЛД (authorized): деньги уже удержаны на карте, и
      // вторая инициация выставила бы ВТОРОЙ счёт по тому же заказу. Покупателю
      // при этом уходит доменная причина («оплата обрабатывается» ≠ «нельзя
      // оплатить»), а не общий «не удалось инициировать оплату».
      const payBlock = paymentBlockFor(found.order.status, found.order.paymentStatus);
      if (payBlock) {
        return jsonDomainError(
          reasonForPaymentBlock(payBlock),
          `Заказ нельзя оплатить (статус заказа «${found.order.status}», оплаты «${found.order.paymentStatus}», причина «${payBlock}»).`,
          cors,
        );
      }

      // АДРЕС ВОЗВРАТА покупателя со шлюза. origin — ТОЛЬКО из ДОВЕРЕННЫХ источников
      // владельца (shop_settings.seo.site_url, иначе STOREFRONT_ALLOWED_ORIGINS);
      // из запроса берётся лишь безопасный ПУТЬ (несёт локаль), number/token —
      // СЕРВЕРНЫЕ. Origin из тела/заголовков запроса НЕ используется: шлюз редиректит
      // покупателя с легитимной платёжной формы, подмена origin = open redirect с
      // утечкой number/token (см. lib/payments/return-url.ts). Токен кладётся ТОЛЬКО
      // если доступ подтверждён самим токеном: доступ по email слабее (номера
      // последовательны, email известен) и не должен превращаться в токен, открывающий
      // коды подарочных сертификатов (order-dto: allowEmail:false).
      const tokenProven = verifyOrderAccess(found.order, { token: accessToken }, process.env, {
        allowEmail: false,
      });
      const resolvedReturnUrl = await resolveOrderReturnUrl({
        orderNumber: found.order.number,
        accessToken: tokenProven ? orderAccessToken(found.order.id) : null,
        requestedUrl: returnUrl,
      });

      // АДРЕС DEMO-СТРАНИЦЫ оплаты — ДРУГОЙ адрес и другой источник: страницы
      // app/mock/<провайдер>/pay лежат в ЭТОМ приложении, а витрина — отдельный
      // контейнер на ДРУГОМ хосте (admin.<домен> против <домена> магазина). Origin
      // витрины сюда подставлять НЕЛЬЗЯ — demo-оплата уводила бы покупателя на сайт,
      // где такой страницы нет (404). Берём публичный адрес приложения из env
      // владельца, иначе origin запроса (см. lib/payments/app-origin.ts). В боевом
      // режиме значение не используется вовсе: ссылку на оплату даёт сам шлюз.
      const mockPageOrigin = resolveMockPageOrigin(req);

      try {
        const res = await new PaymentService().initPayment(found.order, found.items, {
          baseOrigin: mockPageOrigin,
          // Без доверенного origin адрес НЕ передаётся вовсе (как было до пер-заказного
          // возврата). Сырой returnUrl из тела сюда не попадает НИКОГДА.
          returnUrl: resolvedReturnUrl,
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
        return jsonDomainError('payment_init_failed', 'Не удалось инициировать оплату.', cors);
      }
    },
    { module: 'payments', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
