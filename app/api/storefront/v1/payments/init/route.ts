/**
 * POST /api/storefront/v1/payments/init — инициация онлайн-оплаты у АКТИВНОМ
 * эквайере магазина (docs/24 §2, ADR-010/ADR-017). НЕЙТРАЛЬНЫЙ роут витрины.
 *
 * ЗАЧЕМ (аудит major №1). Витрина имела ЕДИНСТВЕННУЮ инициацию оплаты — жёстко в
 * `/payments/paykeeper/init`, а `getActivePaymentProvider()` не вызывался нигде в
 * продакшн-коде. При дефолтном `PAYMENTS_PROVIDER=tbank` и пустых ключах PayKeeper
 * покупателя уводило на MOCK-страницу PayKeeper, где «Оплатить (демо)» помечало
 * заказ оплаченным БЕЗ денег и запускало автовыпуск подарочных сертификатов. Роуты
 * `tbank/init` и `alfabank/init` из витрины были недостижимы.
 *
 * Витрина НЕ знает про эквайеров: эквайер выбирается сервером
 * (`getActivePaymentProvider` → `dispatchInitPayment`), и его имя не утекает в
 * публичный DTO настроек. Provider-роуты `/payments/<провайдер>/init` СОХРАНЕНЫ для
 * внешних потребителей и делят с этим роутом ОДИН обработчик — периметр защиты у
 * всех четырёх одинаков по построению (`lib/payments/init-route.ts`).
 *
 * Конвейер runStorefront: module-gate `payments` (404) → authorizeStorefront →
 * rate-limit → CORS.
 *
 * ANTI-TAMPER (ADR-010): сумма НЕ читается из тела — её считает СЕРВЕР из
 * orders.grand_total. Доступ к заказу подтверждается токеном заказа ИЛИ email
 * покупателя (verifyOrderAccess) — анти-перебор номеров, как GET /orders/:number.
 *
 * Body: { orderNumber, accessToken? | email? , returnUrl? }.
 * Ответ: { data: { provider, paymentUrl, paymentId, status, isMock, invoiceId? } }.
 */

import { runStorefront, handlePreflight } from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { handlePaymentInit } from '@/lib/payments/init-route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => handlePaymentInit(req, cors, 'active'),
    { module: 'payments', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
