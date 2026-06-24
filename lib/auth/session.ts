import { randomBytes } from 'node:crypto';

import { sql } from '@/lib/db/client';
import { buildPermissionSet, type AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
// Имя cookie и TTL вынесены в dependency-free модуль (lib/auth/constants.ts),
// чтобы Edge-middleware мог импортировать их, НЕ затягивая этот серверный
// модуль (node:crypto, postgres) в edge-бандл. Реэкспорт ниже сохраняет
// публичный API session.ts (cookies.ts / actions.ts / тесты импортируют отсюда).
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '@/lib/auth/constants';

/**
 * Слой сессий (Lucia-подход, сессии в БД) — docs/04 §2.2, §4.6, §5.3.
 *
 * Семантика серверного модуля: функции getCurrentUser/requireUser работают
 * только в серверном окружении Next (читают cookie через next/headers,
 * редиректят через next/navigation). Эти серверные API импортируются
 * ДИНАМИЧЕСКИ внутри тел функций — чтобы импорт чистой логики
 * (generateSessionId) из юнит-тестов НЕ тянул next/headers и не падал вне
 * серверного контекста. Так разделены «чистая криптологика» и «серверная
 * обвязка cookie/redirect».
 *
 * Доступ к БД идёт через ленивый клиент `sql` (postgres.js) под ролью app.
 * Импорт `@/lib/db/client` не открывает соединение до первого запроса, поэтому
 * безопасен в окружении без DATABASE_URL (юнит-тесты импортируют этот модуль).
 */

// -----------------------------------------------------------------------------
// Константы (§4.6). Реэкспорт из dependency-free модуля — публичный API сохранён.
// -----------------------------------------------------------------------------

export { SESSION_COOKIE_NAME, SESSION_TTL_MS };

/**
 * Порог скользящего продления: если до истечения осталось меньше половины TTL,
 * `validateSession` продлевает окно (refresh) — комфорт для активных пользователей
 * без бесконечно живущих сессий. Продление НЕ переустанавливает cookie здесь
 * (это обязанность серверной обвязки/middleware при необходимости).
 */
const SESSION_REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

// -----------------------------------------------------------------------------
// Генерация id сессии (чистая криптологика — тестируется ВСЕГДА).
// -----------------------------------------------------------------------------

/** Алфавит base32 (RFC 4648, нижний регистр, без паддинга). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Кодирует буфер в base32-строку (RFC 4648, нижний регистр, без паддинга).
 * Чистая, детерминированная функция.
 */
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
 * Криптослучайный id сессии (§2.2): 20 байт = 160 бит энтропии (> требуемых 120),
 * закодированных в base32 → 32 символа в безопасном для cookie алфавите.
 * Чистая функция: легко тестируется на уникальность/длину/алфавит.
 */
export function generateSessionId(): string {
  return encodeBase32(randomBytes(20));
}

// -----------------------------------------------------------------------------
// Операции над сессиями в БД.
// -----------------------------------------------------------------------------

/**
 * Создаёт сессию: INSERT в `sessions` с expires_at = now + TTL.
 * Возвращает id (для cookie) и точную дату истечения (для maxAge cookie).
 */
export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ id: string; expiresAt: Date }> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await sql`
    INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
    VALUES (
      ${id},
      ${userId},
      ${expiresAt},
      ${meta.ip ?? null},
      ${meta.userAgent ?? null}
    )
  `;

  return { id, expiresAt };
}

/** Строка джойна сессии с пользователем и его правами. */
interface SessionRow {
  user_id: string;
  expires_at: Date;
  status: string;
  is_owner: boolean;
  email: string;
  permissions: PermissionCode[] | null;
}

/**
 * Валидирует сессию по id (§5.3):
 *   1) находит сессию (PK) вместе с пользователем и его правами одним запросом;
 *   2) если сессия не найдена → null;
 *   3) если просрочена (expires_at ≤ now) → ленивый GC (DELETE) и null;
 *   4) если пользователь не active → null (disabled/invited не пускаем);
 *   5) скользящее продление: если осталось < половины TTL — продлеваем окно;
 *   6) собирает эффективные права (объединение прав всех ролей) и возвращает AuthUser.
 */
export async function validateSession(
  sessionId: string,
): Promise<AuthUser | null> {
  const rows = await sql<SessionRow[]>`
    SELECT
      s.user_id,
      s.expires_at,
      u.status,
      u.is_owner,
      u.email,
      array_remove(array_agg(DISTINCT rp.permission_code), NULL) AS permissions
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_roles ur      ON ur.user_id = u.id
    LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE s.id = ${sessionId}
    GROUP BY s.user_id, s.expires_at, u.status, u.is_owner, u.email
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  // (3) Ленивый GC просроченной сессии.
  if (row.expires_at.getTime() <= Date.now()) {
    await invalidateSession(sessionId);
    return null;
  }

  // (4) Только активные пользователи проходят (disabled → доступ закрыт).
  if (row.status !== 'active') {
    return null;
  }

  // (5) Скользящее продление окна, если до истечения осталось мало времени.
  const remainingMs = row.expires_at.getTime() - Date.now();
  if (remainingMs < SESSION_REFRESH_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sql`UPDATE sessions SET expires_at = ${newExpiresAt} WHERE id = ${sessionId}`;
  }

  // (6) Эффективные права = объединение прав всех ролей пользователя.
  const codes = (row.permissions ?? []) as PermissionCode[];
  const permissions = buildPermissionSet([{ permissions: codes }]);

  return {
    id: row.user_id,
    email: row.email,
    isOwner: row.is_owner,
    permissions,
  };
}

/** Удаляет конкретную сессию (логаут). */
export async function invalidateSession(sessionId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}

/**
 * Удаляет все сессии пользователя — ротация при привилегированных действиях
 * (смена пароля, отключение пользователя), §2.2.
 */
export async function invalidateUserSessions(userId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

// -----------------------------------------------------------------------------
// Серверная обвязка (cookie + redirect). next/headers и next/navigation
// импортируются ДИНАМИЧЕСКИ внутри функций — чтобы импорт чистой логики
// (generateSessionId) не тянул серверные API в юнит-окружении.
// -----------------------------------------------------------------------------

/**
 * Текущий пользователь по cookie сессии (§5.3). Читает cookie через
 * next/headers, валидирует сессию. Возвращает null, если cookie нет или
 * сессия невалидна. Серверный API — вызывать только в серверном контексте.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionId) {
    return null;
  }
  return validateSession(sessionId);
}

/**
 * Требует аутентифицированного пользователя (§5.3): если сессии нет —
 * редирект на /admin/login (next/navigation `redirect` бросает и не возвращает).
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (user) {
    return user;
  }
  // redirect() бросает специальное исключение и не возвращается (тип never),
  // но для сужения типов добавляем явный throw после него как недостижимый страховочный путь.
  const { redirect } = await import('next/navigation');
  redirect('/admin/login');
  // Недостижимо: redirect() уже прервал выполнение. Гарантирует тип AuthUser выше.
  throw new Error('unreachable: redirect must have thrown');
}
