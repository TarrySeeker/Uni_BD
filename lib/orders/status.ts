/**
 * Статус-машины модуля orders как ДАННЫЕ (whitelist переходов) + чистые функции
 * (docs/07 §2.8). Единый источник истины переходов — здесь, а не разбросан по
 * коду (как RBAC по кодам, ADR-005): UI рисует кнопки только разрешённых из
 * текущего статуса переходов; сервер валидирует переход той же таблицей.
 *
 * Три независимые, но связанные машины: статус заказа / оплаты / доставки.
 * Все функции чистые и тестируемые (без БД).
 */

import type { DeliveryStatus, OrderStatus, PaymentStatus } from './types';

// -----------------------------------------------------------------------------
// Таблицы допустимых переходов (whitelist). Ключ — «из», значение — список «в».
// Пустой список → терминальный статус (исходящих переходов нет).
// -----------------------------------------------------------------------------

/**
 * (A) Статус заказа (orders.status), §2.8 A.
 *
 *   new ─► awaiting_payment ─► paid ─► packed ─► shipped ─► delivered ─► completed
 *   cancelled — из любого ДО shipped; refunded — из paid/packed/shipped/delivered/completed.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  new: ['awaiting_payment', 'paid', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['packed', 'cancelled', 'refunded'],
  packed: ['shipped', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['completed', 'refunded'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

/**
 * (B) Статус оплаты (orders.payment_status), §2.8 B.
 *   pending ─► authorized ─► paid; ветви → failed; paid → refunded.
 *   На Этапе 3 переходы ручные/mock (нет провайдера). paid проставляет paid_at.
 */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  pending: ['authorized', 'paid', 'failed'],
  authorized: ['paid', 'failed'],
  paid: ['refunded'],
  // failed НЕ терминален: покупатель может ПОВТОРИТЬ оплату из ЛК. Успешный
  // ретрай (webhook Т-Банк) должен пометить заказ оплаченным — иначе деньги
  // получены, а заказ навсегда висит 'failed' (canTransition в applyPaymentStatusTx
  // отбросил бы failed→paid). Пара к isPayable(failed) на витрине.
  failed: ['pending', 'authorized', 'paid'],
  refunded: [],
};

/**
 * (C) Статус доставки (orders.delivery_status), §2.8 C.
 *   pending ─► registered ─► in_transit ─► delivered; ветви → returned, → cancelled.
 *   Источник истины в Этапе 4 — СДЭК webhook; на Этапе 3 — ручная смена в админке.
 */
export const DELIVERY_STATUS_TRANSITIONS: Readonly<
  Record<DeliveryStatus, readonly DeliveryStatus[]>
> = {
  pending: ['registered', 'cancelled'],
  registered: ['in_transit', 'cancelled'],
  in_transit: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
};

// -----------------------------------------------------------------------------
// Обобщённое ядро (одна реализация на три машины).
// -----------------------------------------------------------------------------

/** Машина-дискриминатор для выбора таблицы переходов и текста ошибки. */
export type StatusMachine = 'order' | 'payment' | 'delivery';

const TRANSITIONS: Record<StatusMachine, Readonly<Record<string, readonly string[]>>> = {
  order: ORDER_STATUS_TRANSITIONS,
  payment: PAYMENT_STATUS_TRANSITIONS,
  delivery: DELIVERY_STATUS_TRANSITIONS,
};

const MACHINE_LABEL: Record<StatusMachine, string> = {
  order: 'заказа',
  payment: 'оплаты',
  delivery: 'доставки',
};

/**
 * Чистая проверка: допустим ли переход `from → to` в указанной машине.
 * Переход в тот же статус (`from === to`) считается НЕдопустимым (no-op не нужен).
 */
export function canTransition(
  machine: StatusMachine,
  from: string,
  to: string,
): boolean {
  const next = TRANSITIONS[machine][from];
  if (!next) return false; // неизвестный исходный статус
  return next.includes(to);
}

/**
 * Бросает понятную ошибку, если переход недопустим (для серверной валидации).
 * Возвращает void при допустимом переходе.
 */
export function assertTransition(
  machine: StatusMachine,
  from: string,
  to: string,
): void {
  if (!canTransition(machine, from, to)) {
    throw new Error(
      `Недопустимый переход статуса ${MACHINE_LABEL[machine]}: ` +
        `"${from}" → "${to}".`,
    );
  }
}

/**
 * Список допустимых следующих статусов из текущего (для отрисовки кнопок в UI).
 * Неизвестный статус → пустой список.
 */
export function nextStatuses(machine: StatusMachine, from: string): readonly string[] {
  return TRANSITIONS[machine][from] ?? [];
}

/** Терминален ли статус (нет исходящих переходов). */
export function isTerminal(machine: StatusMachine, status: string): boolean {
  const next = TRANSITIONS[machine][status];
  return next !== undefined && next.length === 0;
}

// -----------------------------------------------------------------------------
// Типобезопасные обёртки на каждую машину (узкие типы статусов).
// -----------------------------------------------------------------------------

/** Допустим ли переход статуса ЗАКАЗА from → to. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return canTransition('order', from, to);
}

/** Допустим ли переход статуса ОПЛАТЫ from → to. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return canTransition('payment', from, to);
}

/** Допустим ли переход статуса ДОСТАВКИ from → to. */
export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return canTransition('delivery', from, to);
}

/** Допустимые следующие статусы заказа из текущего. */
export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[from] ?? [];
}

/** Допустимые следующие статусы оплаты из текущего. */
export function nextPaymentStatuses(from: PaymentStatus): readonly PaymentStatus[] {
  return PAYMENT_STATUS_TRANSITIONS[from] ?? [];
}

/** Допустимые следующие статусы доставки из текущего. */
export function nextDeliveryStatuses(from: DeliveryStatus): readonly DeliveryStatus[] {
  return DELIVERY_STATUS_TRANSITIONS[from] ?? [];
}

/**
 * Кратчайший forward-путь машины ДОСТАВКИ из `from` в `to` (C4-2): список статусов,
 * которые надо применить ПО ШАГАМ (исключая `from`, включая `to`). `[]`, если цель
 * недостижима вперёд или совпадает с `from`.
 *
 * Зачем: СДЭК (best-effort вебхуки / быстрая доставка) может прислать сразу
 * DELIVERED, потеряв промежуточный IN_TRANSIT. Машина допускает только пошаговый
 * forward (registered→in_transit→delivered), поэтому одношаговый
 * applyDeliveryStatus(registered→delivered) молча дропнул бы переход (canTransition
 * false) → у клиента навсегда «registered» для уже доставленной посылки. Этот путь
 * докручивает цепь, записывая каждый промежуточный шаг (история сохраняется).
 *
 * Корректность: DELIVERY_STATUS_TRANSITIONS — ацикличный граф (все рёбра ведут к
 * терминалам), поэтому BFS даёт кратчайший forward-путь, а каждое его ребро —
 * валидный canTransition('delivery', …). Прямое ребро (registered→cancelled) даёт
 * путь длины 1 без синтетических шагов.
 */
export function deliveryForwardPath(
  from: DeliveryStatus,
  to: DeliveryStatus,
): DeliveryStatus[] {
  if (from === to) return [];
  const queue: DeliveryStatus[][] = [[from]];
  const visited = new Set<DeliveryStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const node = path[path.length - 1]!;
    for (const next of DELIVERY_STATUS_TRANSITIONS[node] ?? []) {
      if (next === to) return [...path.slice(1), next];
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return []; // цель недостижима вперёд (например, попытка отката назад)
}

/**
 * Новый статус ОПЛАТЫ при отмене/возврате заказа (или null = не менять).
 *
 * Деньги возвращаем (payment → 'refunded') ТОЛЬКО если они реально получены
 * (payment === 'paid'). Для pending/failed/authorized (деньги НЕ списаны) —
 * оставляем как есть: иначе (а) фиксировался бы фантомный «возврат» по
 * неоплаченному заказу (завышение сумм возвратов в отчётности), (б) писался бы
 * запрещённый машиной переход pending→refunded. Симметрично закрывает два бага:
 *  - отмена ОПЛАЧЕННОГО заказа теперь оформляет возврат (а не «теряет» деньги);
 *  - возврат COD-заказа (payment='pending') НЕ штампует ложный 'refunded'.
 */
export function paymentStatusOnSettle(
  payment: PaymentStatus,
  toOrderStatus: OrderStatus,
): PaymentStatus | null {
  if (toOrderStatus !== 'cancelled' && toOrderStatus !== 'refunded') return null;
  return payment === 'paid' ? 'refunded' : null;
}

/**
 * Очевидные противоречия между независимыми машинами заказа и доставки (§2.8),
 * баг #4 аудита тупиков.
 *
 * Машины ОРТОГОНАЛЬНЫ и остаются независимыми источниками истины — это НЕ
 * блокировка и НЕ авто-синхронизация, а вход для МЯГКОЙ подсказки оператору в UI
 * (role=status). Возвращает список человекочитаемых предупреждений; пустой список
 * — противоречий нет. Сознательно консервативна: репортит только заведомо
 * нелогичные сочетания, чтобы не плодить ложные предупреждения на легитимных
 * транзитных состояниях (например, «отгружен» при доставке «в пути»/«зарегистр.»).
 */
export function detectStatusContradictions(input: {
  orderStatus: OrderStatus;
  deliveryStatus: DeliveryStatus;
}): string[] {
  const out: string[] = [];

  // (1) Заказ уже отгружён/доставлен/завершён, но доставка ещё «Ожидает» (не
  //     начата): отгрузить, не зарегистрировав доставку, нелогично.
  const shippedOrBeyond: OrderStatus[] = ['shipped', 'delivered', 'completed'];
  if (shippedOrBeyond.includes(input.orderStatus) && input.deliveryStatus === 'pending') {
    out.push('Заказ отгружен, но статус доставки всё ещё «Ожидает» — обновите статус доставки.');
  }

  // (2) Доставка отмечена «Доставлена», но статус заказа этого ещё не отражает
  //     (заказ не дошёл даже до отгрузки).
  const beforeShipped: OrderStatus[] = ['new', 'awaiting_payment', 'paid', 'packed'];
  if (input.deliveryStatus === 'delivered' && beforeShipped.includes(input.orderStatus)) {
    out.push('Доставка отмечена «Доставлена», но статус заказа ещё не отражает отгрузку.');
  }

  return out;
}

/**
 * Можно ли инициировать оплату заказа (backend-инвариант для initPayment/webhook).
 *
 * БЛОКИРУЕТ:
 *  - отменённый/возвращённый ЗАКАЗ (order.status ∈ cancelled/refunded) — иначе
 *    отменённый заказ можно было бы оплатить (init не проверял order.status);
 *  - уже оплаченный/возвращённый ПЛАТЁЖ (payment_status ∈ paid/refunded) — повторная
 *    оплата не нужна/некорректна.
 * ДОПУСКАЕТ ретрай неуспешной оплаты (payment='failed' на активном заказе): пара к
 * isPayable(failed) на витрине и машине failed→pending/paid.
 */
export function isOrderPayable(
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
): boolean {
  if (orderStatus === 'cancelled' || orderStatus === 'refunded') return false;
  if (paymentStatus === 'paid' || paymentStatus === 'refunded') return false;
  return true;
}
