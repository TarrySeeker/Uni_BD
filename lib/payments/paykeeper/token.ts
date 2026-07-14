/**
 * Подпись колбэка PayKeeper и Basic-Auth (docs/24 §2, порт tbank/token.ts).
 *
 * ЧИСТЫЕ функции, без сети/БД — всегда тестируемы (unit на эталонном векторе).
 * Секреты (login/password, secret) берутся из config, в код/фронт/логи не попадают.
 *
 * БОЕВАЯ СХЕМА PayKeeper (сверено со старым carre
 * frontend/controllers/api/PaykeeperController.php):
 *   • подпись колбэка key = md5(id + sum + clientid + orderid + secret);
 *   • ответ магазина (ack) строго `OK ` + md5(id + secret) — регистр hex НИЖНИЙ,
 *     'OK', ОДИН пробел, затем hash (PayKeeper ретраит до 50 раз, если ack не
 *     совпал побайтно → критично).
 *
 * ВАЖНО (docs/24 §2): подпись считается по СЫРЫМ posted-строкам (sum НЕ
 * переформатировать — toFixed сломает подпись), сравнение — constant-time.
 */

import { createHash } from 'node:crypto';
import type { PaykeeperCallbackParams } from './types';

/**
 * Ожидаемая подпись колбэка: md5(id + sum + clientid + orderid + secret), hex
 * НИЖНИЙ регистр. Значения конкатенируются ровно как пришли (sum — сырая строка).
 * Экспортируется отдельно — удобно для тестов/отладки (эталонный вектор).
 */
export function signCallback(params: PaykeeperCallbackParams, secret: string): string {
  const source = `${params.id}${params.sum}${params.clientid}${params.orderid}${secret}`;
  return createHash('md5').update(source, 'utf8').digest('hex');
}

/** Сравнение строк постоянного времени-ish (длина + посимвольно, порт safeEqual). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Проверка подписи входящего колбэка (docs/24 §2). Пересобирает md5 по сырым
 * posted-строкам + secret и сравнивает с присланным key (constant-time,
 * регистронезависимо к hex). ЧИСТАЯ. Пустой key/secret → false. Несовпадение →
 * false (вызывающий → не-OK, событие игнорируется).
 */
export function verifyCallbackSignature(
  params: PaykeeperCallbackParams,
  secret: string,
): boolean {
  if (!secret) return false;
  const provided = params.key;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = signCallback(params, secret);
  return safeEqual(provided.toLowerCase(), expected.toLowerCase());
}

/**
 * Строка подтверждения колбэка для PayKeeper (docs/24 §2, сверено с carre):
 * `OK ` + md5(id + secret). Формат КРИТИЧЕН — 'OK', один пробел, hex нижний
 * регистр; иначе PayKeeper метит платёж «без оповещения» и ретраит.
 */
export function buildCallbackAck(id: string, secret: string): string {
  const hash = createHash('md5').update(`${id}${secret}`, 'utf8').digest('hex');
  return `OK ${hash}`;
}

/**
 * Заголовок Basic-Auth серверного API PayKeeper: `Basic ` + base64(login:password)
 * (docs/24 §2, сверено с carre PayKeeper::prepareHeaders). ЧИСТАЯ.
 */
export function basicAuthHeader(login: string, password: string): string {
  const b64 = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  return `Basic ${b64}`;
}
