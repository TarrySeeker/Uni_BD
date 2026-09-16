/**
 * Аутентификация и разбор входящего callback АТОЛ Pay. ЧИСТЫЙ модуль.
 *
 * 🔴 ПОЧЕМУ ЭТОТ ФАЙЛ ВЫГЛЯДИТ НЕ КАК sign.ts ДРУГИХ ПРОВАЙДЕРОВ.
 * У Т-Банка и Озона вебхук подписан (HMAC/SHA-256 по полям тела), и проверка
 * сводится к пересчёту подписи. У АТОЛ Pay подписи НЕТ ВООБЩЕ — ни HMAC, ни
 * секрета уведомлений, ни контрольной суммы: ни в таблице 6 (payment/deposit/
 * cancel/refund), ни в таблице 7 (fiscal).
 *
 * Следствие: тело callback НЕ доказывает отправителя. Если доверять ему как
 * есть, кто угодно, узнав URL вебхука, объявит неоплаченный заказ оплаченным.
 *
 * Защита строится из двух слоёв, и первый сам по себе недостаточен:
 *   1) СЕКРЕТ В QUERY (этот файл). Документация прямо разрешает произвольные
 *      query-параметры в notificationUrl. Это единственный канал
 *      аутентификации, который даёт API. Слабое место — секрет попадает в
 *      логи прокси, поэтому он не может быть единственной защитой;
 *   2) СВЕРКА ЧЕРЕЗ API (service.ts). Callback трактуется лишь как сигнал
 *      «сходи проверь»; решение о смене статуса заказа принимается ТОЛЬКО по
 *      ответу GET /payments/{orderId}/status, запрошенному нами по токену.
 *      Этот слой не зависит от секрета и защищает даже при его утечке.
 */

import { timingSafeEqual } from 'node:crypto';

import type { AtolCallback, AtolCallbackType } from './types';

/** Имя query-параметра с секретом в notificationUrl. */
export const CALLBACK_SECRET_PARAM = 'secret';

const CALLBACK_TYPES: readonly AtolCallbackType[] = [
  'payment',
  'deposit',
  'cancel',
  'refund',
  'fiscal',
];

/**
 * Сверяет присланный секрет с настроенным за постоянное время.
 *
 * 🔴 Если секрет магазином не настроен (`expected === null`), не проходит
 * НИКТО — включая запрос с пустым секретом. Иначе проверка выродилась бы в
 * сравнение пустого с пустым и пропускала бы всех подряд.
 */
export function verifyCallbackSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Разная длина — заведомо не совпадение; timingSafeEqual на разных длинах
  // бросает, поэтому отсекаем заранее. Длина секрета не является тайной.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Добавляет секрет query-параметром, сохраняя уже имеющиеся параметры. */
export function buildNotificationUrl(baseUrl: string, secret: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set(CALLBACK_SECRET_PARAM, secret);
  return url.toString();
}

/**
 * Разбирает тело callback. Возвращает null для всего, что не является
 * распознаваемым событием, — без исключения: роут обязан ответить внятным
 * кодом, а не упасть.
 *
 * 🔴 Поля `status` и `paymentStatus` сохраняются РАЗДЕЛЬНО и ничего не
 * «додумывается»: `status: "success"` означает лишь, что запрос обработан,
 * а не что заказ оплачен (в примере документации он соседствует с
 * paymentStatus: 0 — «в обработке»).
 */
export function parseCallback(raw: unknown): AtolCallback | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const orderId = typeof o.orderId === 'string' ? o.orderId.trim() : '';
  if (!orderId) return null;

  const type = typeof o.type === 'string' ? (o.type as AtolCallbackType) : null;
  if (!type || !CALLBACK_TYPES.includes(type)) return null;

  const status = typeof o.status === 'string' ? o.status : '';

  // paymentStatus приходит числом и ОТСУТСТВУЕТ в событии fiscal.
  // Ноль — значащее значение, поэтому проверяем тип, а не истинность.
  const paymentStatus = typeof o.paymentStatus === 'number' ? o.paymentStatus : undefined;
  const amount = typeof o.amount === 'number' ? o.amount : undefined;

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  return {
    status,
    orderId,
    type,
    paymentStatus,
    amount,
    sessionType: o.sessionType === 'twoStep' ? 'twoStep' : o.sessionType === 'oneStep' ? 'oneStep' : undefined,
    paidAt: str(o.paidAt) ?? null,
    canceledAt: str(o.canceledAt) ?? null,
    depositedAt: str(o.depositedAt) ?? null,
    receiptId: str(o.receiptId),
    receiptType: o.receiptType === 'sell_refund' ? 'sell_refund' : o.receiptType === 'sell' ? 'sell' : undefined,
    errorCode: str(o.errorCode),
    errorMessage: str(o.errorMessage),
  };
}

/**
 * 🔴 Признак непробитого чека: деньги списаны, а фискализация не прошла.
 *
 * Документация АТОЛа дословно: «транзакция не отменяется, если чек отправился
 * неуспешно». То есть покупатель заплатил, чека нет — нарушение 54-ФЗ, которое
 * иначе обнаружится только по жалобе. Такое событие обязано подниматься
 * заметным алертом оператору, а не проглатываться в журнале.
 */
export function isFailedFiscalization(cb: AtolCallback): boolean {
  return cb.type === 'fiscal' && cb.status !== 'success';
}
