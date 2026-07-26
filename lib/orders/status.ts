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
 * НЕЗАКРЫТЫЕ статусы заказа — те, из которых заказ ещё поедет покупателю и
 * резерв остатка на inventory ЕЩЁ ДЕРЖИТСЯ (commit выполняется на входе в
 * 'shipped'). Единый источник истины для двух вещей:
 *   • какой эффект над резервом даёт переход (stockEffectFor, actions.ts);
 *   • можно ли удалять товар/вариант из каталога (аудит-находка #9): удаление
 *     каскадом уносит строку inventory вместе с резервом такого заказа, после
 *     чего его НЕЛЬЗЯ перевести в «Отгружен» — commitReservation навсегда
 *     возвращает false.
 */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'new',
  'awaiting_payment',
  'paid',
  'packed',
];

/** Набор для быстрых проверок принадлежности (тот же список). */
export const RESERVE_HELD_STATUSES: ReadonlySet<OrderStatus> = new Set(OPEN_ORDER_STATUSES);

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
 * ПОЧЕМУ по заказу нельзя выставить счёт (`null` — можно).
 *
 *  • `order_closed`    — заказ отменён/возвращён: платить не за что;
 *  • `payment_settled` — расчёт по заказу завершён (деньги получены или уже
 *                        возвращены покупателю);
 *  • `funds_held`      — ХОЛД: деньги удержаны на карте, ждём подтверждения.
 *
 * Причина нужна не только домену: витрина показывает покупателю РАЗНЫЙ текст для
 * «уже оплачено» и «оплата в обработке» (lib/storefront/error-reasons.ts).
 */
export type PaymentBlock = 'order_closed' | 'payment_settled' | 'funds_held';

/**
 * Единственный источник истины «можно ли выставлять счёт по заказу» — гард
 * initPayment у ВСЕХ эквайеров и их HTTP-роутов.
 *
 * 🔴 ДЕНЬГИ. Разбирается ВЕСЬ алфавит `payment_status` (CHECK в
 * db/migrations/0012_orders.sql = ключи PAYMENT_STATUS_TRANSITIONS), явным
 * switch: новый статус не скомпилируется без осознанного решения, а сторож
 * tests/orders/payment-payable-alphabet.test.ts фиксирует решения по каждому.
 *
 *  pending    — ✅ счёт не оплачен, деньги НЕ удержаны: штатная оплата и штатный
 *               ретрай «ушёл на шлюз и вернулся ни с чем».
 *  authorized — ❌ ХОЛД (двухстадийная оплата Т-Банка/Альфа-Банка, orderStatus=1
 *               у RBS). Деньги УЖЕ удержаны на карте покупателя; вторая инициация
 *               выставит второй счёт по тому же заказу → второе списание.
 *               Прежняя редакция гарда пропускала этот статус — это и была дыра
 *               двойной оплаты: витрина кнопку спрятала, а сервер счёт выставлял.
 *  paid       — ❌ деньги получены.
 *  failed     — ✅ попытка не удалась, денег на заказе нет (машина допускает
 *               failed → pending/authorized/paid) — ретрай покупателя легитимен.
 *  refunded   — ❌ деньги возвращены покупателю, расчёт закрыт.
 *
 * ⚠️ НЕ ТУПИК. Незавершённый холд (истёк, шлюз потерял подтверждение) не запирает
 * заказ навсегда — платформа выводит его из `authorized` БЕЗ покупателя:
 *   1) крон-сверка reconcile-pending (lib/payments/{tbank,alfabank}/cron.ts) берёт
 *      заказы в pending И authorized, спрашивает шлюз и доводит статус: снятый/
 *      отклонённый холд → 'failed' (снова оплачиваемо), подтверждённый → 'paid';
 *   2) оператор в админке: PAYMENT_STATUS_TRANSITIONS.authorized = paid | failed —
 *      ручная смена статуса возвращает заказ в оплачиваемое состояние;
 *   3) отмена/возврат заказа снимает холд (REVERSED) — заказ закрывается честно.
 * Покупатель при этом видит не «сбой», а доменную причину «оплата обрабатывается».
 */
export function paymentBlockFor(
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
): PaymentBlock | null {
  // Мёртвый заказ важнее статуса оплаты: платить по нему нельзя ничем.
  if (orderStatus === 'cancelled' || orderStatus === 'refunded') return 'order_closed';

  switch (paymentStatus) {
    case 'pending':
      return null;
    case 'failed':
      return null;
    case 'authorized':
      return 'funds_held';
    case 'paid':
      return 'payment_settled';
    case 'refunded':
      return 'payment_settled';
  }
}

/**
 * Можно ли инициировать оплату заказа (backend-инвариант для initPayment/webhook).
 * Тонкая обёртка над `paymentBlockFor` — решение одно и живёт в одном месте.
 */
export function isOrderPayable(
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
): boolean {
  return paymentBlockFor(orderStatus, paymentStatus) === null;
}
