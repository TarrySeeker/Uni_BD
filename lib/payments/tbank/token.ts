/**
 * Подпись Token Т-Банка (docs/15 §5, порт идеи verifyWebhookIp но на подписи).
 *
 * ЧИСТЫЕ функции, без сети/БД — всегда тестируемы (unit-тест на эталонном
 * векторе из доки). `Password` — единственный секрет подписи, берётся из
 * config (TBANK_PASSWORD), в код/фронт/логи не попадает.
 *
 * АЛГОРИТМ (docs/15 §5.1, подтверждён офиц. /eacq/intro/developer/token + 2 SDK):
 *   1) взять ТОЛЬКО корневые пары ключ-значение; ИСКЛЮЧИТЬ Token и ВЛОЖЕННЫЕ
 *      объекты/массивы (Receipt/DATA/Items — в подпись НЕ идут);
 *   2) добавить пару Password = пароль терминала;
 *   3) отсортировать пары ПО КЛЮЧУ в алфавитном порядке;
 *   4) КОНКАТЕНИРОВАТЬ ТОЛЬКО ЗНАЧЕНИЯ (без ключей/разделителей) в одну строку;
 *   5) SHA-256 (UTF-8) → hex в нижнем регистре → поле Token.
 *
 * Сериализация значений (docs/15 §5.1, §9.1): булевы → "true"/"false", числа →
 * строкой, null/undefined → пропускаются (не участвуют). Точная сериализация
 * сверяется по эталонному вектору доки при первом боевом запросе.
 */

import { createHash } from 'node:crypto';
import type { TbankPayload } from './types';

/** Ключи, которые НИКОГДА не участвуют в подписи (сам Token). */
const EXCLUDED_KEYS = new Set(['Token']);

/**
 * Признак скалярного значения, участвующего в подписи. Вложенные объекты/массивы
 * (Receipt/DATA/Items) исключаются; null/undefined — тоже (не вносят значения).
 */
function isSignableScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Сериализует скалярное значение для подписи (булевы → "true"/"false", числа → строкой). */
function serializeValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Собирает конкатенированную строку значений для подписи (шаги 1–4 §5.1).
 * Корневые скалярные поля + Password, отсортированные по ключу, значения склеены.
 * Экспортируется отдельно — удобно для отладки/тестов сериализации.
 */
export function buildTokenSource(payload: TbankPayload, password: string): string {
  const pairs: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(payload)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    // Вложенные объекты/массивы (Receipt/DATA/Items) — НЕ в подпись.
    if (!isSignableScalar(value)) continue;
    pairs.push([key, serializeValue(value)]);
  }

  // Password добавляется как обычная пара и тоже сортируется по ключу.
  pairs.push(['Password', password]);

  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return pairs.map(([, v]) => v).join('');
}

/**
 * Подпись Token исходящего запроса (docs/15 §5.1). Возвращает SHA-256 hex
 * (lowercase) от конкатенации значений корневых скалярных полей + Password.
 * НЕ мутирует payload — вызывающий проставляет результат в поле Token.
 */
export function signToken(payload: TbankPayload, password: string): string {
  const source = buildTokenSource(payload, password);
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Сравнение строк постоянного времени-ish (длина + посимвольно, порт order-dto safeEqual). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Проверка Token входящего webhook (docs/15 §5.2). Пересобирает значения
 * корневых полей тела (исключая Token и вложенные объекты) + Password,
 * подписывает и сравнивает с присланным Token (constant-time). ЧИСТАЯ.
 * Несовпадение/отсутствие Token → false (вызывающий → 403, событие игнорируется).
 */
export function verifyNotificationToken(body: TbankPayload, password: string): boolean {
  const provided = body.Token;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = signToken(body, password);
  return safeEqual(provided.toLowerCase(), expected.toLowerCase());
}
