/**
 * ПОЛИТИКА ВОЗВРАТА ДЕНЕГ — ЧИСТЫЕ функции (без БД/сети), единый смысл «возврата»
 * для всех входов админки.
 *
 * Аудит 2026-07-26, критичное №7 («две кнопки Возврат с разным денежным смыслом»)
 * и major №38 («шлюзовой возврат — заглушка, а интерфейс рапортует выполнено»).
 *
 * ПРОБЛЕМА. Возврат оформлялся тремя разными путями с разными последствиями:
 *   • «Статус заказа → Возврат» (refundOrder) — дёргал платёжный шлюз;
 *   • «Статус оплаты → Возврат» (setPaymentStatus) — штамповал payment_status
 *     ='refunded' БЕЗ обращения к шлюзу;
 *   • «Статус заказа → Отменён» для оплаченного заказа — то же самое молча.
 * После любого из них заказ становился терминальным (refunded/cancelled), а
 * настоящий возврат — недоступным. Деньги оставались у магазина, система считала
 * возврат состоявшимся («бумажный возврат»).
 *
 * РЕШЕНИЕ (эта политика + единый исполнитель возврата в lib/orders/actions.ts):
 *   1) пометить деньги возвращёнными можно ТОЛЬКО через денежный путь, который
 *      обращается к шлюзу (dispatchRefund); все прочие переходы, которые
 *      подразумевали бы 'refunded', отклоняются;
 *   2) исход возврата КЛАССИФИЦИРУЕТСЯ по фактическому ответу шлюза, а не по
 *      намерению: «шлюз вернул» / «надо вернуть руками» / «возвращать нечего»;
 *   3) «надо вернуть руками» требует ЯВНОГО подтверждения оператора и попадает в
 *      аудит и в историю заказа отдельной пометкой — чтобы через месяц было видно,
 *      ушли деньги или нет.
 *
 * Функции чистые: одна и та же классификация используется сервером (по реальному
 * ответу шлюза) и подсказкой в UI (по способности провайдера, ДО обращения к шлюзу).
 */

import { providerRefundCapability } from '@/lib/payments/refund-capability';

/** Что произошло с деньгами покупателя при возврате. */
export type RefundMoneyOutcome =
  /** Шлюз принял возврат — деньги ушли покупателю автоматически. */
  | 'gateway_refunded'
  /** Деньги получены, но шлюз их НЕ вернул: перевод делает человек. */
  | 'manual_required'
  /** Возвращать нечего: оплата не поступала (COD/pending/failed) либо к оплате 0. */
  | 'nothing_to_return'
  /** Шлюз отказал: возврат НЕ состоялся, заказ помечать возвращённым нельзя. */
  | 'gateway_failed';

/** Минимальная форма ответа шлюзового возврата (см. RefundDispatchResult). */
export interface RefundGatewayResultLike {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

/** Статусы оплаты, при которых деньги РЕАЛЬНО у магазина/банка (есть что возвращать). */
const CAPTURED_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['paid', 'authorized']);

/**
 * Классифицирует ФАКТИЧЕСКИЙ исход возврата.
 *
 * Порядок проверок важен:
 *   1) отказ шлюза — терминальный «нет» (ничего не помечаем);
 *   2) деньги не захвачены ИЛИ сумма к возврату 0 — возвращать нечего (COD,
 *      неоплаченный заказ, заказ, полностью покрытый подарочным сертификатом:
 *      его номинал возвращает releaseGiftTx в сетле, а не платёжный шлюз);
 *   3) шлюз пропущен (заглушка PayKeeper / manual / провайдер не задан) — деньги
 *      получены, но не возвращены → нужен ручной перевод;
 *   4) иначе шлюз реально вернул.
 *
 * Неизвестная сумма (NaN/Infinity) трактуется как «деньги были»: безопаснее лишний
 * раз потребовать подтверждение, чем молча оформить «бумажный возврат».
 */
export function classifyRefundOutcome(input: {
  paymentStatus: string;
  amountKop: number;
  gateway: RefundGatewayResultLike;
}): RefundMoneyOutcome {
  if (!input.gateway.ok) return 'gateway_failed';

  const captured = CAPTURED_PAYMENT_STATUSES.has(input.paymentStatus);
  const hasAmount = !Number.isFinite(input.amountKop) || input.amountKop > 0;
  if (!captured || !hasAmount) return 'nothing_to_return';

  return input.gateway.skipped === true ? 'manual_required' : 'gateway_refunded';
}

/**
 * Требуется ли ЯВНОЕ подтверждение оператора («деньги возвращены вне системы»).
 * Только для manual_required: там система физически не может вернуть деньги, а
 * тихо пометить заказ возвращённым — ровно та ошибка, из-за которой покупатель
 * оставался без денег.
 */
export function refundNeedsManualAck(outcome: RefundMoneyOutcome): boolean {
  return outcome === 'manual_required';
}

/**
 * Пометка в истории заказа/комментарии перехода — денежный след операции.
 * Разные тексты обязательны: по журналу должно быть видно, ушли деньги или нет.
 */
export function refundOutcomeNote(outcome: RefundMoneyOutcome): string {
  switch (outcome) {
    case 'gateway_refunded':
      return 'Возврат: деньги возвращены платёжным шлюзом.';
    case 'manual_required':
      return 'Возврат: шлюз деньги НЕ возвращал — перевод выполнен вне системы (подтверждено оператором).';
    case 'nothing_to_return':
      return 'Возврат: движения денег не было (оплата не поступала или к оплате 0).';
    case 'gateway_failed':
      return 'Возврат: платёжный шлюз отказал.';
  }
}

/**
 * Сообщение отказа, когда оператор не подтвердил ручной возврат. Явно называет
 * провайдера и сумму: менеджер должен понимать, что именно ему предстоит перевести.
 */
export function manualRefundRequiredMessage(input: {
  paymentProvider: string | null;
  amountLabel: string;
}): string {
  const provider = input.paymentProvider ?? 'офлайн/COD';
  return (
    `Платёжный шлюз «${provider}» не умеет возвращать деньги автоматически: ` +
    `${input.amountLabel} нужно вернуть покупателю вручную (перевод/касса). ` +
    'Оформите возврат ещё раз, подтвердив, что деньги возвращены вне системы, — ' +
    'подтверждение попадёт в журнал аудита.'
  );
}

/**
 * ПРЕДСКАЗАНИЕ исхода для интерфейса (до обращения к шлюзу): по способности
 * провайдера и статусу оплаты. Сервер всё равно перепроверит по РЕАЛЬНОМУ ответу
 * шлюза — предсказание нужно лишь для честного текста подтверждения.
 */
export type RefundMoneyPlan = 'gateway' | 'manual' | 'none';

export function planRefundMoney(input: {
  paymentStatus: string;
  paymentProvider: string | null;
  amountKop: number;
}): RefundMoneyPlan {
  const captured = CAPTURED_PAYMENT_STATUSES.has(input.paymentStatus);
  const hasAmount = !Number.isFinite(input.amountKop) || input.amountKop > 0;
  if (!captured || !hasAmount) return 'none';
  return providerRefundCapability(input.paymentProvider) === 'gateway' ? 'gateway' : 'manual';
}
