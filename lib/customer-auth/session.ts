import { randomBytes } from 'node:crypto';

import { sql } from '@/lib/db/client';
import {
  CUSTOMER_SESSION_TTL_MS,
  CUSTOMER_SESSION_REFRESH_THRESHOLD_MS,
} from './constants';
import type { Customer, CustomerStatus, SessionMeta } from './types';
import { mapCustomer } from './repository';
import { hashToken } from './token';

/**
 * Слой сессий покупателя на таблице customer_sessions (0045) — docs/24 §6.
 *
 * ПОЛНОСТЬЮ отдельный от admin lib/auth/session: своя таблица, свой TTL, НИКАКИХ
 * ролей/прав.
 *
 * БЕЗОПАСНОСТЬ (7a security-medium): сырой токен сессии (base32, 160 бит) уходит
 * клиенту (cookie + Bearer), но в customer_sessions.id хранится ТОЛЬКО его
 * sha256(raw) — та же модель, что у одноразовых токенов (token.ts). Утечка БД
 * (дамп/лог/read-only доступ) не даёт восстановить активные токены и угнать
 * сессии. Поиск/валидация/инвалидация идут по хешу предъявленного токена. Схема
 * 0045 (id text PK) не меняется — колонка просто держит хеш вместо сырого токена.
 *
 * Чистая криптологика (generateCustomerSessionId) вынесена так, чтобы юнит-тест
 * мог её импортировать без БД/Next (модуль тянет ленивый sql-клиент, который не
 * открывает соединение до первого запроса).
 */

// -----------------------------------------------------------------------------
// Генерация id сессии (чистая криптологика).
// -----------------------------------------------------------------------------

/** Алфавит base32 (RFC 4648, нижний регистр, без паддинга) — безопасен для cookie. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Криптослучайный id сессии покупателя: 20 байт = 160 бит энтропии, base32 → 32
 * символа. Чистая функция (тестируется на длину/алфавит/уникальность).
 */
export function generateCustomerSessionId(): string {
  return encodeBase32(randomBytes(20));
}

// -----------------------------------------------------------------------------
// Операции над сессиями в БД.
// -----------------------------------------------------------------------------

/**
 * Создаёт сессию: генерирует СЫРОЙ токен (уходит клиенту), а в customer_sessions.id
 * пишет его sha256-хеш. Возвращает { id: rawToken } — сырой токен для cookie/Bearer.
 */
export async function createCustomerSession(
  customerId: string,
  meta: SessionMeta = {},
): Promise<{ id: string; expiresAt: Date }> {
  const rawToken = generateCustomerSessionId();
  const idHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS);

  await sql`
    INSERT INTO customer_sessions (id, customer_id, expires_at, ip, user_agent)
    VALUES (
      ${idHash},
      ${customerId},
      ${expiresAt},
      ${meta.ip ?? null},
      ${meta.userAgent ?? null}
    )
  `;

  // Клиенту отдаём СЫРОЙ токен; в БД лежит только его хеш.
  return { id: rawToken, expiresAt };
}

interface CustomerSessionRow extends Record<string, unknown> {
  expires_at: Date;
  status: CustomerStatus;
}

/**
 * Валидирует сессию покупателя по токену:
 *   1) находит сессию + покупателя одним запросом;
 *   2) нет сессии → null;
 *   3) просрочена → ленивый GC (DELETE) + null;
 *   4) покупатель не 'active' (disabled/guest) → null;
 *   5) скользящее продление окна при остатке < половины TTL;
 *   6) возвращает доменного Customer (без password_hash).
 */
export async function validateCustomerSession(
  sessionToken: string,
): Promise<Customer | null> {
  if (!sessionToken) {
    return null;
  }

  // Ищем по хешу предъявленного токена — в БД лежит sha256(raw), не сырой токен.
  const idHash = hashToken(sessionToken);

  const rows = await sql<CustomerSessionRow[]>`
    SELECT
      s.expires_at,
      c.id, c.email, c.name, c.phone, c.status,
      c.email_verified_at, c.last_login_at, c.preferred_locale,
      c.orders_count, c.total_spent, c.created_at, c.updated_at
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ${idHash}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  // (3) Ленивый GC просроченной сессии.
  if (row.expires_at.getTime() <= Date.now()) {
    await invalidateCustomerSession(sessionToken);
    return null;
  }

  // (4) Только активные аккаунты проходят (disabled/guest — доступ закрыт).
  if (row.status !== 'active') {
    return null;
  }

  // (5) Скользящее продление окна.
  const remainingMs = row.expires_at.getTime() - Date.now();
  if (remainingMs < CUSTOMER_SESSION_REFRESH_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS);
    await sql`UPDATE customer_sessions SET expires_at = ${newExpiresAt} WHERE id = ${idHash}`;
  }

  return mapCustomer(row);
}

/** Удаляет конкретную сессию (логаут) по хешу предъявленного сырого токена. */
export async function invalidateCustomerSession(sessionToken: string): Promise<void> {
  await sql`DELETE FROM customer_sessions WHERE id = ${hashToken(sessionToken)}`;
}

/**
 * Удаляет ВСЕ сессии покупателя — ротация при смене пароля / блокировке
 * (инвалидация всех устройств).
 */
export async function invalidateAllCustomerSessions(customerId: string): Promise<void> {
  await sql`DELETE FROM customer_sessions WHERE customer_id = ${customerId}`;
}
