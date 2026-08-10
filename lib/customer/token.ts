import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Одноразовые токены покупателя (сброс пароля / верификация email, docs/34).
 *
 * Чистая криптологика, без БД/Next — тестируется напрямую.
 *
 * МОДЕЛЬ БЕЗОПАСНОСТИ:
 *   • сырой токен (raw) — 32 байта энтропии (256 бит), hex → уходит покупателю в
 *     письме, НИГДЕ не хранится;
 *   • в БД (customer_auth_tokens.token_hash) лежит ТОЛЬКО sha256(raw): утечка БД
 *     не даёт восстановить активные ссылки. sha256 (а не argon2) здесь достаточно:
 *     токен высокоэнтропийный и короткоживущий, перебор бессмыслен;
 *   • сверка — по хешу (лукап UNIQUE(token_hash)); одноразовость/expiry — в SQL.
 */

/** Генерирует сырой одноразовый токен: 32 байта (256 бит) в hex. */
export function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

/** sha256(raw) в hex — то, что хранится в БД. Детерминировано. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time сравнение двух hex-хешей одинаковой длины. Используется там, где
 * сверка идёт в приложении, а не через UNIQUE-лукап (защита от timing-утечки).
 */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}
