/**
 * POST /api/storefront/v1/payments/paykeeper/init — инициация онлайн-оплаты PayKeeper
 * для витрины (docs/24 §2, ADR-010/ADR-017).
 *
 * 🔴 LEGACY-РОУТ КОНКРЕТНОГО ЭКВАЙЕРА. Витрина сюда БОЛЬШЕ НЕ ХОДИТ: она
 * инициирует оплату через нейтральный `/payments/init`, который выбирает АКТИВНЫЙ
 * эквайер магазина (аудит major №1 — раньше витрина была жёстко зашита на
 * PayKeeper, из-за чего при `PAYMENTS_PROVIDER=tbank` покупатель попадал на
 * mock-страницу PayKeeper и «оплачивал» заказ БЕЗ денег). Роут СОХРАНЁН рабочим для
 * внешних потребителей и обратной совместимости: форма ответа не изменилась.
 *
 * Периметр защиты и весь конвейер — ОБЩИЕ с `/payments/init`
 * (`lib/payments/init-route.ts`): module-gate `payments` (404) →
 * authorizeStorefront → rate-limit → CORS, единый 404 анти-перебора номеров, гард
 * `paymentBlockFor` (в т.ч. холд), anti-tamper (сумму считает СЕРВЕР из
 * orders.grand_total, ADR-010), доверенный адрес возврата (open redirect) и origin
 * demo-страницы. Одна копия правил на все init-роуты — расходиться нечему.
 *
 * Отличие от нейтрального роута РОВНО одно: эквайер зафиксирован (`'paykeeper'`), а не
 * берётся из конфига магазина.
 *
 * Body: { orderNumber, accessToken? | email? , returnUrl? }.
 * Ответ: { data: { paymentUrl, invoiceId, status, isMock } }.
 */

import { runStorefront, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { handlePaymentInit } from '@/lib/payments/init-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) =>
      // Форма ответа зафиксирована историческим контрактом этого роута: только
      // provider-специфичный ключ идентификатора счёта, без поля `provider`.
      handlePaymentInit(req, cors, 'paykeeper', (res) => ({
        paymentUrl: res.paymentUrl,
        invoiceId: res.paymentId,
        status: res.status,
        isMock: res.isMock,
      })),
    { module: 'payments', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
