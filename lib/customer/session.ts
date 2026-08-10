/**
 * Серверные сессии покупателя — зеркало сессий админки, но БЕЗ ролей и прав.
 *
 * Почему сессии в базе, а не подписанный токен: выход и «выйти на всех
 * устройствах» обязаны срабатывать немедленно, а отозвать выданный JWT нельзя —
 * он действителен до истечения, что бы ни случилось с аккаунтом.
 *
 * КЛЮЧЕВОЕ: в базе лежит sha256 ОТ токена, сырой токен есть только у клиента.
 * Иначе дамп базы, лог запроса или доступ «только на чтение» давали бы готовый
 * набор действующих сессий. Хеша здесь достаточно (в отличие от паролей): токен
 * высокоэнтропийный и короткоживущий, перебирать его бессмысленно, а замедлять
 * проверку на каждом запросе — вредно.
 *
 * Доступ к базе — ленивый клиент: импорт модуля не открывает соединение, поэтому
 * модуль безопасен в юнит-окружении.
 */

import { sql } from '@/lib/db/client';
import { generateSessionId } from '@/lib/auth/session';

import { hashToken } from './token';
import {
  CUSTOMER_SESSION_TTL_MS,
  CUSTOMER_SESSION_REFRESH_THRESHOLD_MS,
} from './constants';
import type { CustomerAuth, CustomerStatus } from './types';

/**
 * Создаёт сессию покупателя.
 *
 * Возвращает СЫРОЙ токен — он уйдёт в cookie витрины и больше нигде не появится.
 *
 * ⚠️ `ip` пишется в колонку типа `inet`: значение обязано быть уже нормализовано
 * (`lib/server/request-ip.ts`). Сырой заголовок роняет вставку на приведении
 * типа, а вместе с ней и вход в кабинет.
 */
export async function createCustomerSession(
  customerId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionId();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS);

  await sql`
    INSERT INTO customer_sessions (id, customer_id, expires_at, ip, user_agent)
    VALUES (
      ${hashToken(token)},
      ${customerId},
      ${expiresAt},
      ${meta.ip ?? null},
      ${meta.userAgent ?? null}
    )
  `;

  return { token, expiresAt };
}

interface SessionRow {
  customer_id: string;
  expires_at: Date;
  status: CustomerStatus;
  email: string;
  name: string;
  phone: string | null;
  email_verified_at: Date | null;
}

/**
 * Проверяет сессию по сырому токену из cookie:
 *   1) ищет по хешу сессию и покупателя одним запросом;
 *   2) просроченная — удаляет и отказывает;
 *   3) не `active` (гость или заблокирован) — отказывает, не дожидаясь истечения:
 *      блокировка из админки должна действовать сразу;
 *   4) при близком истечении продлевает окно;
 *   5) отдаёт данные покупателя без служебных полей.
 */
export async function validateCustomerSession(
  rawToken: string,
): Promise<CustomerAuth | null> {
  const tokenHash = hashToken(rawToken);

  const rows = await sql<SessionRow[]>`
    SELECT s.customer_id,
           s.expires_at,
           c.status,
           c.email,
           c.name,
           c.phone,
           c.email_verified_at
      FROM customer_sessions s
      JOIN customers c ON c.id = s.customer_id
     WHERE s.id = ${tokenHash}
  `;
  const row = rows[0];
  if (!row) return null;

  if (row.expires_at.getTime() <= Date.now()) {
    // Ленивая уборка: строку всё равно надо убрать, а раз мы уже здесь —
    // делаем это сразу. Массовую чистку выполняет фоновая задача.
    await invalidateCustomerSession(rawToken);
    return null;
  }

  if (row.status !== 'active') return null;

  // Скользящее продление: только когда осталось меньше половины срока. Продлять
  // на каждом запросе значило бы писать в базу при каждом открытии страницы.
  const remainingMs = row.expires_at.getTime() - Date.now();
  if (remainingMs < CUSTOMER_SESSION_REFRESH_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS);
    await sql`
      UPDATE customer_sessions SET expires_at = ${newExpiresAt} WHERE id = ${tokenHash}
    `;
  }

  return {
    id: row.customer_id,
    email: row.email,
    name: row.name,
    phone: row.phone ?? null,
    emailVerified: row.email_verified_at !== null,
  };
}

/** Завершает одну сессию (выход на текущем устройстве). */
export async function invalidateCustomerSession(rawToken: string): Promise<void> {
  await sql`DELETE FROM customer_sessions WHERE id = ${hashToken(rawToken)}`;
}

/**
 * Завершает ВСЕ сессии покупателя.
 *
 * Вызывается при смене и сбросе пароля: если пароль меняют из-за утечки, старая
 * сессия злоумышленника не должна пережить смену.
 */
export async function invalidateCustomerSessions(customerId: string): Promise<void> {
  await sql`DELETE FROM customer_sessions WHERE customer_id = ${customerId}`;
}

/**
 * Удаляет просроченные сессии. Для фоновой задачи.
 *
 * Без неё строки покупателей, которые не вернулись, копятся вечно: ленивая
 * уборка срабатывает только при попытке использовать сессию, а её никто не
 * использует. Индекс по сроку годности для этого запроса уже есть.
 */
export async function purgeExpiredCustomerSessions(): Promise<void> {
  await sql`DELETE FROM customer_sessions WHERE expires_at <= now()`;
}
