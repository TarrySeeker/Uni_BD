/**
 * Исход оплаты на странице /cart/success — ЧИСТАЯ логика (ни React, ни сети).
 *
 * ЗАЧЕМ. Корзина очищается ДО ухода на платёжный шлюз, а заказ к этому моменту
 * уже создан (`status='new'`, `payment_status='pending'`). Если покупатель нажал
 * «Отмена», банк отказал или вкладка закрылась, он возвращается на страницу
 * успеха — и раньше она одинаково бодро печатала «Спасибо! Ваш заказ принят»
 * для всех трёх случаев, не давая ни одного способа доплатить. Тупик: заказ
 * есть, корзина пуста, платить нечем и негде.
 *
 * ИСТОЧНИК ИСТИНЫ — статус заказа из GET /orders/:number (сервер, HMAC-токен).
 * Параметр возврата шлюза лишь УТОЧНЯЕТ ещё не подтверждённое состояние:
 *   • `?payment=cancelled` — покупатель нажал «Отмена»;
 *   • `?payment=failed`    — подтверждение не прошло;
 *   • `?paid=1`            — оплата подтверждена demo-шлюзом;
 * (см. app/mock/{paykeeper,tbank}/pay/page.tsx). Боевой PayKeeper возвращает по
 * настройкам своего ЛК и наших параметров не несёт — поэтому «нет подсказки» это
 * штатный случай, а не ошибка.
 *
 * 🔴 ДВА ДЕНЕЖНЫХ ПРАВИЛА (регрессии первой редакции этого модуля):
 *
 * P1. Алфавит `payment_status` разбирается ЦЕЛИКОМ и ЯВНО. Платформа отдаёт пять
 *     значений (CHECK в db/migrations/0012_orders.sql = PAYMENT_STATUS_TRANSITIONS
 *     в lib/orders/status.ts): pending / authorized / paid / failed / refunded.
 *     Первая редакция знала лишь paid/failed/refunded, и `authorized` проваливался
 *     в «ожидает оплаты» С КНОПКОЙ. Но authorized — это ХОЛД: деньги уже удержаны
 *     на карте, повторное нажатие списывает их второй раз. Всё, чего в алфавите
 *     нет (чужой тенант, будущий статус), трактуется КОНСЕРВАТИВНО — «платить не
 *     предлагать»; шов между алфавитами витрины и платформы сторожит тест.
 *
 * P2. «Оплатил и вернулся раньше вебхука» определяется ФАКТОМ С СЕРВЕРА, а не
 *     подсказкой шлюза. Факт — `paymentInitiatedAt` (orders.payment_initiated_at,
 *     проставляется при выставлении счёта ЛЮБЫМ провайдером): пока с момента
 *     инициации прошло меньше SETTLING_WINDOW_MS, кнопки оплаты нет. Раньше эту
 *     роль играл только `?paid=1`, который ставит исключительно наш mock.
 *     🔴 ВЫХОД ИЗ ТУПИКА: окно КОНЕЧНО. Если подтверждение так и не пришло,
 *     кнопка возвращается сама — покупатель не заперт (страница показывает это
 *     текстом `settlingHint`).
 *
 * P3. ПРИОРИТЕТ: серверный факт > подсказка из адресной строки. `?payment=…`
 *     приходит из query — оно не аутентифицировано и легко оказывается УСТАРЕВШИМ
 *     (покупатель открыл старую вкладку или ссылку из истории, а платёж тем
 *     временем прошёл). Вторая редакция возвращала по такой подсказке кнопку
 *     оплаты ДО проверки свежести инициации, а ветка `failed` не проверяла её
 *     вовсе — хотя именно failed чаще всего и ретраят. Теперь окно из P2 гасит
 *     кнопку в ОБЕИХ ветках, где оплата предлагается, а подсказка допускается
 *     лишь к тому, что сервер не опроверг: она уточняет ПРИЧИНУ отсутствия денег
 *     и никогда не открывает оплату поверх идущего платежа. Разрешено ей и
 *     сужать (`?paid=1` прячет кнопку) — это в сторону безопасности денег.
 */

import type { Dictionary } from './dictionaries';

/** Подсказка платёжного шлюза из query возврата. */
export type GatewayHint = 'paid' | 'cancelled' | 'failed' | null;

/**
 * Что показать покупателю:
 *  - paid      — деньги получены;
 *  - settling  — деньги, возможно, уже списаны/удержаны, подтверждение в пути
 *                (холд `authorized`, свежая инициация, `?paid=1`, неизвестный
 *                статус) — платить повторно НЕЛЬЗЯ предлагать;
 *  - awaiting  — заказ есть, оплаты нет (в т.ч. закрытая вкладка);
 *  - cancelled — покупатель отменил оплату на шлюзе;
 *  - failed    — платёж не прошёл;
 *  - closed    — заказ отменён/возвращён, платить по нему нельзя.
 */
export type PaymentOutcome = 'paid' | 'settling' | 'awaiting' | 'cancelled' | 'failed' | 'closed';

export const PAYMENT_OUTCOMES: readonly PaymentOutcome[] = [
  'paid',
  'settling',
  'awaiting',
  'cancelled',
  'failed',
  'closed',
];

export interface PaymentResultView {
  outcome: PaymentOutcome;
  /** Покупателю имеет смысл предложить оплату этого заказа прямо сейчас. */
  canRetry: boolean;
}

/** Статусы заказа, при которых оплата невозможна в принципе. */
const DEAD_ORDER_STATUSES = ['cancelled', 'refunded'];

/**
 * ВЕСЬ алфавит `orders.payment_status` платформы. Источник — CHECK в
 * db/migrations/0012_orders.sql, он же ключи PAYMENT_STATUS_TRANSITIONS в
 * lib/orders/status.ts. Витрина — отдельное приложение и серверных модулей не
 * импортирует, поэтому алфавит продублирован здесь, а совпадение двух списков
 * сторожит тест: появится новый статус — тест станет красным ДО выката.
 */
export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
] as const;

export type KnownPaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Сколько времени после ИНИЦИАЦИИ платежа считаем, что подтверждение ещё в пути,
 * и не предлагаем платить снова (P2).
 *
 * 15 минут — с запасом перекрывает то, что реально стоит между «покупатель ушёл
 * на шлюз» и «вебхук доставлен»: ввод карты + 3-D Secure/СБП (минуты), сетевые
 * ретраи колбэка (PayKeeper ретраит до 50 раз) и крон-сверка платежей. И при этом
 * ограничивает НЕУДОБСТВО обратного случая: покупатель, который передумал на
 * странице шлюза (нажал «Отмена», получил отказ банка или просто закрыл вкладку),
 * ждёт кнопку не дольше этих 15 минут — и страница говорит ему об этом словами
 * (`settlingHint`). Подсказка из query окно НЕ укорачивает (P3): пока сервер
 * считает платёж идущим, ей верить нельзя — она могла устареть.
 */
export const SETTLING_WINDOW_MS = 15 * 60 * 1000;

/** Известен ли статус этой версии витрины (иначе — консервативная ветка). */
function isKnownPaymentStatus(value: string): value is KnownPaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Оплата инициирована и подтверждение ещё МОЖЕТ прийти (P2).
 *
 * `null` (счёт не выставляли ни разу) и `undefined` (сервер старой версии, поля в
 * DTO ещё нет) → false: блокировать оплату без всякого основания нельзя, это был
 * бы новый тупик. Нечитаемое значение → тоже false. Время в БУДУЩЕМ (перекос
 * часов витрины и БД) → true: это свежая инициация, а не старая.
 */
function isPaymentPending(initiatedAt: string | null | undefined, now: number): boolean {
  if (!initiatedAt) return false;
  const at = Date.parse(initiatedAt);
  if (!Number.isFinite(at)) return false;
  return now - at < SETTLING_WINDOW_MS;
}

/**
 * Читает подсказку шлюза из query. Всё, что не входит в наш узкий словарь,
 * игнорируется: чужие параметры боевого шлюза не должны влиять на текст.
 */
export function readGatewayHint(sp: { payment?: string; paid?: string }): GatewayHint {
  if (sp.paid === '1') return 'paid';
  if (sp.payment === 'cancelled') return 'cancelled';
  if (sp.payment === 'failed') return 'failed';
  return null;
}

/** Сумма к оплате больше нуля (0 бывает при полном покрытии сертификатом). */
function hasAmountDue(grandTotal: string): boolean {
  const n = Number(grandTotal);
  return Number.isFinite(n) && n > 0;
}

/**
 * Исход оплаты + можно ли предложить кнопку «оплатить».
 *
 * Порядок проверок важен:
 *  1. отменённый/возвращённый заказ — важнее факта оплаты (деньги возвращают,
 *     платить нельзя);
 *  2. НЕИЗВЕСТНЫЙ статус оплаты — консервативно: не выдаём за оплату и не зовём
 *     платить (мы не знаем, удержаны ли деньги);
 *  3. далее — явный разбор ВСЕГО алфавита (P1), где `authorized` = холд, то есть
 *     деньги уже удержаны и вторая оплата запрещена;
 *  4. в обеих оставшихся ветках (`pending`, `failed`) первым спрашивается
 *     СЕРВЕРНЫЙ ФАКТ — свежая инициация платежа (P2/P3); подсказка шлюза
 *     рассматривается только после него и только для уточнения причины.
 *
 * `now` — только для тестируемости (по умолчанию системное время).
 */
export function resolvePaymentResult(input: {
  paymentStatus: string;
  status: string;
  grandTotal: string;
  hint: GatewayHint;
  /** `orders.payment_initiated_at` из DTO: когда по заказу выставили счёт. */
  paymentInitiatedAt?: string | null;
  now?: number;
}): PaymentResultView {
  const { paymentStatus, status, grandTotal, hint } = input;
  const now = input.now ?? Date.now();

  // (1) Заказ закрыт — платить по нему нельзя ни при каком статусе оплаты.
  if (DEAD_ORDER_STATUSES.includes(status) || paymentStatus === 'refunded') {
    return { outcome: 'closed', canRetry: false };
  }

  // (2) Статус не из нашего алфавита: молчим про оплату и НЕ предлагаем платить.
  //     Покупателю остаётся перепроверка статуса и постоянная ссылка на заказ.
  //     ⚠️ Единственная ветка, где текст «подтверждение в пути» может оказаться
  //     оптимистичным (кнопка сама не вернётся — это не таймер). Ветка достижима
  //     ТОЛЬКО при version skew «новый сервер / старая витрина»: расширение
  //     алфавита платформы ловит сторожевой тест ещё до выката. Обратный размен —
  //     показать кнопку поверх неизвестного состояния — это риск второго списания.
  if (!isKnownPaymentStatus(paymentStatus)) {
    return { outcome: 'settling', canRetry: false };
  }

  const canRetry = hasAmountDue(grandTotal);

  // 🔴 (3) СЕРВЕРНЫЙ ФАКТ, который перебивает подсказку из адресной строки: по
  //     заказу только что выставили счёт, значит платёж идёт прямо сейчас и его
  //     подтверждение ещё в пути. Считается ОДИН раз и применяется в КАЖДОЙ ветке,
  //     где предлагается платить (не только в `pending`): `failed` — самая частая
  //     ветка ретрая, и там гонка ровно та же. Окно конечно (SETTLING_WINDOW_MS).
  const settling = isPaymentPending(input.paymentInitiatedAt, now);

  // (4) Явный разбор алфавита. Свитч исчерпывающий по KnownPaymentStatus —
  //     новый статус в алфавите не скомпилируется без ветки.
  switch (paymentStatus) {
    case 'paid':
      return { outcome: 'paid', canRetry: false };

    // 🔴 ХОЛД: деньги удержаны на карте, ждём списания/подтверждения. Подсказка
    // шлюза здесь ничего не отменяет — она про попытку, а холд уже стоит.
    case 'authorized':
      return { outcome: 'settling', canRetry: false };

    // Недостижимо (отсеяно в (1)), но ветка обязана быть — иначе исчерпывающий
    // разбор алфавита превратится в «прочее».
    case 'refunded':
      return { outcome: 'closed', canRetry: false };

    // 🔴 Ниже — ЕДИНСТВЕННЫЕ две ветки, где оплату вообще можно предложить. Обе
    //    обязаны СНАЧАЛА спросить серверный факт `settling` (см. выше) и только
    //    потом смотреть на подсказку.
    case 'failed':
      // Сервер уже высказался о платеже — подсказка причину НЕ переписывает, она
      // может лишь СУЗИТЬ (шлюз отчитался об успехе, а статус ещё 'failed').
      if (settling || hint === 'paid') return { outcome: 'settling', canRetry: false };
      return { outcome: 'failed', canRetry };

    case 'pending':
      if (settling || hint === 'paid') return { outcome: 'settling', canRetry: false };
      // Сервер не опроверг подсказку («в процессе») — она УТОЧНЯЕТ, почему денег
      // нет: покупатель отменил или банк отказал. Деньги не удержаны — кнопка есть.
      if (hint === 'cancelled') return { outcome: 'cancelled', canRetry };
      if (hint === 'failed') return { outcome: 'failed', canRetry };
      return { outcome: 'awaiting', canRetry };
  }
}

/** Ключи словаря: заголовок страницы по исходу. */
export const SUCCESS_TITLE_KEY: Record<PaymentOutcome, keyof Dictionary['success']> = {
  paid: 'title',
  settling: 'title',
  awaiting: 'titleAwaiting',
  cancelled: 'titleCancelled',
  failed: 'titleFailed',
  closed: 'titleClosed',
};

/** Ключи словаря: пояснительный текст по исходу (шаблон с {number}). */
export const SUCCESS_TEXT_KEY: Record<PaymentOutcome, keyof Dictionary['success']> = {
  paid: 'textPaid',
  settling: 'textSettling',
  awaiting: 'textAwaiting',
  cancelled: 'textCancelled',
  failed: 'textFailed',
  closed: 'textClosed',
};
