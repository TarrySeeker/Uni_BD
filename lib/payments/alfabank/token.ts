/**
 * Проверка checksum колбэка Альфа-Банка (RBS symmetric-key HMAC, порт
 * paykeeper/token.ts). У Альфа-Банка НЕТ подписи исходящих запросов (аутентификация
 * — userName/password на каждый запрос, см. client.ts), поэтому здесь — ТОЛЬКО
 * верификация входящего колбэка и она НЕОБЯЗАТЕЛЬНА (лишь если в ЛК задан симметричный
 * ключ → ALFABANK_CALLBACK_SECRET).
 *
 * ЧИСТЫЕ функции, без сети/БД — всегда тестируемы. Секрет берётся из config, в код/
 * фронт/логи не попадает.
 *
 * СХЕМА (RBS symmetric-key checksum):
 *   1) взять ВСЕ query-параметры колбэка КРОМЕ checksum;
 *   2) отсортировать пары по имени в алфавитном порядке;
 *   3) склеить строку `name;value;` для каждой пары по порядку;
 *   4) HMAC-SHA256(source, secret) → hex В ВЕРХНЕМ регистре → сверить с checksum.
 * Сравнение — регистронезависимо к hex, constant-time.
 */

import { createHmac } from 'node:crypto';

/**
 * Ожидаемый checksum колбэка: HMAC-SHA256 по параметрам (без checksum),
 * отсортированным по имени, конкатенированным как `name;value;`. Возвращает hex
 * ВЕРХНИЙ регистр (как RBS). Экспортируется отдельно — удобно для тестов/отладки.
 */
export function signCallback(params: Record<string, string>, secret: string): string {
  const entries = Object.entries(params)
    .filter(([k]) => k !== 'checksum')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const source = entries.map(([k, v]) => `${k};${v};`).join('');
  return createHmac('sha256', secret).update(source, 'utf8').digest('hex').toUpperCase();
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
 * Проверка checksum входящего колбэка. Пересобирает HMAC по параметрам (без checksum)
 * + secret и сравнивает с присланным checksum (constant-time, регистронезависимо к
 * hex). ЧИСТАЯ. Пустой checksum/secret → false. Несовпадение → false.
 *
 * ВАЖНО: вызывается ТОЛЬКО когда secret задан. Если ALFABANK_CALLBACK_SECRET пуст
 * (mock/не настроен) — верификация не выполняется вовсе (см. service.handleCallback):
 * колбэк принимается, checksum не требуется.
 */
export function verifyCallbackChecksum(
  params: Record<string, string>,
  secret: string,
): boolean {
  if (!secret) return false;
  const provided = params.checksum;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = signCallback(params, secret);
  return safeEqual(provided.toUpperCase(), expected.toUpperCase());
}
