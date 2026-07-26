/**
 * РЕЕСТР СПОСОБНОСТИ ПРОВАЙДЕРА ВЕРНУТЬ ДЕНЬГИ САМ (ЧИСТЫЙ модуль: без сети/БД).
 *
 * Аудит 2026-07-26, major №38: для PayKeeper (а также COD/manual/провайдер не
 * задан) шлюзовой возврат — ЗАГЛУШКА (`skipped:'manual'`), но интерфейс рапортовал
 * «Возврат: выполнено». Менеджер не мог отличить «деньги ушли покупателю» от
 * «деньги надо перевести руками». Чтобы UI мог написать честный текст ДО обращения
 * к шлюзу, а серверная политика — потребовать явного подтверждения, способность
 * провайдера объявлена ЗДЕСЬ, отдельно от `lib/payments/dispatch.ts`.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ: `dispatch.ts` импортирует сервисы эквайеров, а те —
 * `lib/db/client`; клиентский компонент карточки заказа такой импорт не переживёт
 * (сторожит tests/build/client-server-boundary.guard.test.ts). Здесь — только
 * данные и чистые функции, поэтому модуль безопасен и для клиента, и для сервера.
 *
 * МУЛЬТИТЕНАНТНОСТЬ: реестр — единственный источник истины о наборе провайдеров
 * возврата; `dispatchRefund` импортирует `RefundProvider`/`isRefundProvider`
 * отсюда, поэтому новый эквайер невозможно добавить в один список и забыть в
 * другом (exhaustive switch перестанет компилироваться).
 */

/**
 * Кто фактически возвращает деньги:
 *  • `gateway` — адаптер умеет reverse/refund по API (деньги двигает система);
 *  • `manual`  — автоматического возврата нет (заглушка/офлайн/наличные):
 *                перевод делает человек, система лишь фиксирует факт.
 */
export type RefundCapability = 'gateway' | 'manual';

/** Провайдеры с определённым путём возврата (≡ ветки exhaustive switch dispatchRefund). */
export const REFUND_PROVIDERS = ['tbank', 'paykeeper', 'alfabank', 'manual', 'gift'] as const;

export type RefundProvider = (typeof REFUND_PROVIDERS)[number];

export function isRefundProvider(v: string): v is RefundProvider {
  return (REFUND_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Способность каждого провайдера. Меняется ВМЕСТЕ с адаптером: как только у
 * PayKeeper появится реальный reverse — здесь ставится 'gateway', и весь UI/политика
 * перестраиваются сами (текст подтверждения, требование подтверждения возврата вне
 * системы, пометка в аудите).
 */
export const PROVIDER_REFUND_CAPABILITY: Readonly<Record<RefundProvider, RefundCapability>> = {
  tbank: 'gateway',
  alfabank: 'gateway',
  // MVP: refundPayment всегда возвращает skipped:'manual' (см. lib/payments/paykeeper/service).
  paykeeper: 'manual',
  // Ручной/офлайн-платёж: шлюза нет вовсе.
  manual: 'manual',
  // Сертификат: возврат баланса ортогонален платёжному refund (releaseGiftTx).
  gift: 'manual',
};

/**
 * Способность провайдера заказа. `null` (COD/офлайн, провайдер не проставлен) и
 * неизвестное значение → 'manual': КОНСЕРВАТИВНО, потому что обещать автоматический
 * возврат там, где его не будет, — это и есть «бумажный возврат» из находки №7.
 */
export function providerRefundCapability(provider: string | null | undefined): RefundCapability {
  if (!provider || !isRefundProvider(provider)) return 'manual';
  return PROVIDER_REFUND_CAPABILITY[provider];
}
