/**
 * ОБЩИЙ ОБРАБОТЧИК init-роутов оплаты (`/payments/init` + legacy
 * `/payments/{paykeeper,tbank,alfabank}/init`).
 *
 * ЗАЧЕМ. Три provider-роута были байт-в-байт одинаковыми, кроме импорта
 * `PaymentService` и имени ключа идентификатора счёта в ответе. Периметр защиты
 * (единый 404 анти-перебора, гард `paymentBlockFor`, anti-tamper, доверенный
 * `returnUrl`, origin demo-страницы) был скопирован ТРИЖДЫ — четвёртая копия под
 * новый нейтральный роут гарантировала бы расхождение при первой же правке
 * безопасности. Здесь копия ОДНА, и любой роут получает ровно её.
 *
 * ПЕРИМЕТР (не ослаблять — см. подробные обоснования в комментариях ниже):
 *   • конвейер runStorefront вызывающего роута: module-gate `payments` (404) →
 *     authorizeStorefront → rate-limit → CORS;
 *   • ЕДИНЫЙ ответ «не найдено» для несуществующего И неавторизованного заказа
 *     (перебор номеров не должен отличать «нет заказа» от «нет доступа»);
 *   • оплатить можно только ЖИВОЙ заказ без денег покупателя (`paymentBlockFor`),
 *     холд (`authorized`) отсекается отдельной причиной — второй счёт = второе
 *     списание;
 *   • ANTI-TAMPER (ADR-010): сумма НЕ читается из тела — её считает адаптер из
 *     `orders.grand_total`;
 *   • адрес возврата — ТОЛЬКО из доверенных источников владельца (open redirect),
 *     токен кладётся лишь при доступе, подтверждённом САМИМ токеном (не email).
 */

import { z } from 'zod';
import type { NextResponse } from 'next/server';
import {
  jsonData,
  jsonError,
  jsonDomainError,
  parseJsonBody,
} from '@/lib/storefront/response';
import { getOrderByNumber } from '@/lib/orders/repository';
import { paymentBlockFor } from '@/lib/orders/status';
import { reasonForPaymentBlock } from '@/lib/storefront/error-reasons';
import { orderAccessToken, verifyOrderAccess } from '@/lib/storefront/order-dto';
import { resolveOrderReturnUrl } from '@/lib/payments/return-url';
import { resolveMockPageOrigin } from '@/lib/payments/app-origin';
import {
  dispatchInitPayment,
  PaymentInitUnavailableError,
  type InitDispatchResult,
} from '@/lib/payments/init-dispatch';
import type { PaymentProvider } from '@/lib/payments/provider';

/** Тело инициации оплаты — общее для всех init-роутов. */
export const PaymentInitSchema = z
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

/**
 * Как роут выбирает эквайер:
 *   • `'active'` — по конфигу магазина (`getActivePaymentProvider`), нейтральный
 *     `/payments/init`, куда ходит витрина;
 *   • конкретный провайдер — legacy-роуты `/payments/<провайдер>/init`, поведение
 *     которых зафиксировано контрактом и внешними потребителями.
 */
export type InitProviderSelector = PaymentProvider | 'active';

/** Форма тела ответа init-роута (по умолчанию — нейтральная). */
export type InitResponseShape = (res: InitDispatchResult) => Record<string, unknown>;

/** Нейтральное тело ответа `/payments/init`: провайдера выбирает сервер и называет его. */
export const neutralInitResponse: InitResponseShape = (res) => ({
  provider: res.provider,
  paymentUrl: res.paymentUrl,
  paymentId: res.paymentId,
  status: res.status,
  isMock: res.isMock,
  // PayKeeper-специфичный алиас остаётся, если адаптер его дал — старым клиентам,
  // читающим invoiceId, ответ по-прежнему подходит. Поле НЕОБЯЗАТЕЛЬНОЕ.
  ...(res.invoiceId ? { invoiceId: res.invoiceId } : {}),
});

/**
 * Общее тело обработчика POST init (вызывается ВНУТРИ `runStorefront` роута, уже
 * после module-gate/авторизации/rate-limit — ослабить периметр отсюда нельзя).
 */
export async function handlePaymentInit(
  req: Request,
  cors: Record<string, string>,
  selector: InitProviderSelector,
  shape: InitResponseShape = neutralInitResponse,
): Promise<NextResponse> {
  const body = await parseJsonBody(req);
  if (!body.ok) {
    return jsonError('bad_request', 'Тело запроса не является валидным JSON.', cors);
  }

  const parsed = PaymentInitSchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(
      'bad_request',
      parsed.error.issues[0]?.message ?? 'Некорректное тело запроса.',
      cors,
    );
  }

  const { orderNumber, accessToken, email, returnUrl } = parsed.data;

  const found = await getOrderByNumber(orderNumber);

  // Единый ответ «не найдено» для несуществующего И для неавторизованного доступа
  // (зеркалит GET /orders/:number) — чтобы перебор номеров не отличал «нет заказа»
  // (404) от «нет доступа» (403) и не раскрывал существование/диапазон заказов.
  // Доменная причина едет рядом с транспортным 404 (аудит №3/№6): витрина показывает
  // свой перевод, а не серверную русскую строку.
  if (!found || !verifyOrderAccess(found.order, { token: accessToken, email })) {
    return jsonError('not_found', 'Заказ не найден.', cors, {}, 'order_not_found');
  }

  // Оплатить можно только ЖИВОЙ заказ, по которому НЕТ денег покупателя. Тот же
  // инвариант, что в service.initPayment (paymentBlockFor) — но проверить его ОБЯЗАН
  // и роут: init-эндпоинт публичный, запрос шлётся и мимо витрины.
  // 🔴 Кроме отменённого/возвращённого заказа и уже оплаченного/возвращённого платежа
  // гард отсекает ХОЛД (authorized): деньги уже удержаны на карте, и вторая инициация
  // выставила бы ВТОРОЙ счёт по тому же заказу. Покупателю уходит доменная причина
  // («оплата обрабатывается» ≠ «нельзя оплатить»), а не общий отказ.
  const payBlock = paymentBlockFor(found.order.status, found.order.paymentStatus);
  if (payBlock) {
    return jsonDomainError(
      reasonForPaymentBlock(payBlock),
      `Заказ нельзя оплатить (статус заказа «${found.order.status}», оплаты «${found.order.paymentStatus}», причина «${payBlock}»).`,
      cors,
    );
  }

  // АКТИВНЫЙ ЭКВАЙЕР магазина. Читается ЛЕНИВО (динамический импорт) и ПОСЛЕ гардов:
  // роут провайдера свой выбор уже сделал, а нейтральному нужен конфиг магазина.
  let provider: PaymentProvider;
  if (selector === 'active') {
    const { getActivePaymentProvider } = await import('@/lib/payments/provider');
    provider = getActivePaymentProvider();
  } else {
    provider = selector;
  }

  // АДРЕС ВОЗВРАТА покупателя со шлюза. origin — ТОЛЬКО из ДОВЕРЕННЫХ источников
  // владельца (shop_settings.seo.site_url, иначе STOREFRONT_ALLOWED_ORIGINS); из
  // запроса берётся лишь безопасный ПУТЬ (несёт локаль), number/token — СЕРВЕРНЫЕ.
  // Origin из тела/заголовков запроса НЕ используется: шлюз редиректит покупателя с
  // легитимной платёжной формы, подмена origin = open redirect с утечкой
  // number/token (см. lib/payments/return-url.ts). Токен кладётся ТОЛЬКО если доступ
  // подтверждён самим токеном: доступ по email слабее (номера последовательны, email
  // известен) и не должен превращаться в токен, открывающий коды подарочных
  // сертификатов (order-dto: allowEmail:false).
  const tokenProven = verifyOrderAccess(found.order, { token: accessToken }, process.env, {
    allowEmail: false,
  });
  const resolvedReturnUrl = await resolveOrderReturnUrl({
    orderNumber: found.order.number,
    accessToken: tokenProven ? orderAccessToken(found.order.id) : null,
    requestedUrl: returnUrl,
  });

  // АДРЕС DEMO-СТРАНИЦЫ оплаты — ДРУГОЙ адрес и другой источник: страницы
  // app/mock/<провайдер>/pay лежат в ЭТОМ приложении, а витрина — отдельный контейнер
  // на ДРУГОМ хосте (admin.<домен> против <домена> магазина). Origin витрины сюда
  // подставлять НЕЛЬЗЯ — demo-оплата уводила бы покупателя на сайт, где такой
  // страницы нет (404). Берём публичный адрес приложения из env владельца, иначе
  // origin запроса (см. lib/payments/app-origin.ts). В боевом режиме значение не
  // используется вовсе: ссылку на оплату даёт сам шлюз.
  const mockPageOrigin = resolveMockPageOrigin(req);

  try {
    const res = await dispatchInitPayment(provider, found.order, found.items, {
      baseOrigin: mockPageOrigin,
      // Без доверенного origin адрес НЕ передаётся вовсе (как было до пер-заказного
      // возврата). Сырой returnUrl из тела сюда не попадает НИКОГДА.
      returnUrl: resolvedReturnUrl,
    });
    return jsonData(shape(res), {}, cors);
  } catch (err) {
    // Активный провайдер БЕЗ онлайн-инициации (`manual`) или неизвестный — это не
    // «шлюз отказал», а «онлайн-оплаты в этом магазине нет». Отдельная доменная
    // причина: покупателю нужно сказать «оплатите иначе», а не «попробуйте ещё раз».
    // 🔴 Молчаливый фолбэк на другой эквайер здесь ЗАПРЕЩЁН: он уводил бы покупателя
    // на mock-страницу чужого шлюза, где «оплата» проходит БЕЗ денег.
    if (err instanceof PaymentInitUnavailableError) {
      console.warn('[payments] init отклонён:', err.message);
      return jsonDomainError(
        'payments_disabled',
        'Онлайн-оплата для этого магазина недоступна.',
        cors,
      );
    }
    // Сырую диагностику шлюза покупателю не отдаём (может нести внутренние детали).
    return jsonDomainError('payment_init_failed', 'Не удалось инициировать оплату.', cors);
  }
}
