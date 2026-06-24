'use server';

import { z } from 'zod';

import { sql } from '@/lib/db/client';
import {
  createSession,
  invalidateSession,
  invalidateUserSessions,
  requireUser,
  SESSION_COOKIE_NAME,
} from '@/lib/auth/session';
import { setSessionCookie, clearSessionCookie } from '@/lib/auth/cookies';
import {
  verifyPassword,
  verifyDummy,
  hashPassword,
} from '@/lib/auth/password';
import {
  checkLoginRate,
  registerLoginFailure,
  resetLoginFailures,
} from '@/lib/auth/rate-limit';
import { writeAudit } from '@/lib/audit/log';
import { normalizeClientIp } from '@/lib/server/request-ip';

/**
 * Server Actions аутентификации (docs/04 §4.1, §4.4, §4.6, §7.1).
 *
 * Переиспользует готовые модули и НЕ дублирует их логику:
 *   - сессии:   lib/auth/session.ts (createSession / invalidate / requireUser)
 *   - cookie:   lib/auth/cookies.ts (set/clear)
 *   - пароли:   lib/auth/password.ts (verifyPassword/verifyDummy/hashPassword)
 *   - rate:     lib/auth/rate-limit.ts (check/register/reset)
 *   - аудит:    lib/audit/log.ts (writeAudit)
 *
 * Почему login/logout пишутся напрямую, а не через defineAction:
 *   defineAction (§4.7) — пайплайн для МУТАЦИЙ аутентифицированного пользователя
 *   (guard getCurrentUser → ...). У login пользователя ещё нет (он только входит),
 *   а logout не требует права. Поэтому здесь — тонкая прямая реализация поверх
 *   тех же helper-модулей. changePassword тоже использует requireUser напрямую
 *   (требуется текущий пароль + ротация сессий, что не вписывается в дженерик-пайплайн).
 */

// -----------------------------------------------------------------------------
// Единое сообщение об ошибке логина (§4.4) — не раскрывает, что именно неверно.
// -----------------------------------------------------------------------------

const LOGIN_ERROR = 'Неверный логин или пароль' as const;

/** Результат логина для формы (логин не редиректит до успеха). */
export type LoginResult =
  | { ok: true }
  | { ok: false; message: string };

/** Результат смены пароля. */
export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

// -----------------------------------------------------------------------------
// Zod-схемы входа.
// -----------------------------------------------------------------------------

const loginSchema = z.object({
  // Логин ИЛИ email: владелец может входить произвольным значением (напр. `admin`),
  // не только email. Значение хранится в колонке users.email (citext, поиск
  // регистронезависим). Формат не ограничиваем — только trim + непустая строка.
  email: z.string().trim().min(1).max(200),
  // Пароль на входе валидируем минимально (не раскрываем политику на логине).
  password: z.string().min(1),
});

/** Минимальная длина нового пароля при смене (§4.3, политика паролей). */
const MIN_PASSWORD_LENGTH = 8;

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Минимальная длина пароля — ${MIN_PASSWORD_LENGTH} символов`),
});

// -----------------------------------------------------------------------------
// Получение IP/UA из заголовков запроса (next/headers).
// -----------------------------------------------------------------------------

const FORWARDED_FOR_HEADER = 'x-forwarded-for';
const REAL_IP_HEADER = 'x-real-ip';

/**
 * Извлекает IP и User-Agent текущего запроса для аудита/rate-limit/сессий.
 *
 * IP из X-Forwarded-For / X-Real-IP ВАЛИДИРУЕТСЯ (normalizeClientIp) перед
 * возвратом: эти заголовки подконтрольны клиенту/прокси, а сырое значение идёт
 * в колонку `inet` (sessions.ip). Кривой/подделанный заголовок без валидации
 * ломал бы createSession (каст к inet падает) → весь логин. Невалидный IP → undefined.
 */
async function getRequestMeta(): Promise<{ ip?: string; userAgent?: string }> {
  const { headers } = await import('next/headers');
  const store = await headers();
  const ip = normalizeClientIp(
    store.get(FORWARDED_FOR_HEADER),
    store.get(REAL_IP_HEADER),
  );
  const userAgent = store.get('user-agent') ?? undefined;
  return { ip, userAgent };
}

// -----------------------------------------------------------------------------
// Извлечение полей из FormData ИЛИ обычного объекта.
// -----------------------------------------------------------------------------

/** Нормализует вход формы: поддерживает и FormData, и plain-object. */
function readFields(
  raw: FormData | Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  if (raw instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const value = raw.get(key);
      out[key] = typeof value === 'string' ? value : undefined;
    }
    return out;
  }
  return raw;
}

/** Строка пользователя для логина. */
interface UserAuthRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
}

// -----------------------------------------------------------------------------
// login — вход (§4.1, §4.4, §4.5).
// -----------------------------------------------------------------------------

/**
 * Вход в админку. Принимает FormData (из формы логина) либо объект {email,password}.
 *
 * Поток (§4.4 timing-защита, §4.5 rate-limit):
 *   1) Zod-валидация входа → при ошибке единое сообщение (не раскрываем детали);
 *   2) rate-limit по ip и логину (checkLoginRate); при блокировке — единое сообщение;
 *   3) поиск пользователя по логину (колонка email); если нет — verifyDummy (уравнивание времени);
 *   4) verifyPassword; при неудаче registerLoginFailure + audit 'auth.login_failed';
 *   5) при успехе resetLoginFailures, createSession, setSessionCookie,
 *      audit 'auth.login', обновление last_login_at, redirect '/admin'.
 *
 * Возвращает LoginResult ТОЛЬКО при ошибке; при успехе redirect прерывает выполнение.
 */
export async function login(
  raw: FormData | { email: string; password: string },
): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(readFields(raw, ['email', 'password']));
  if (!parsed.success) {
    // Единое сообщение (§4.4): не раскрываем, какое поле невалидно.
    return { ok: false, message: LOGIN_ERROR };
  }
  const { email, password } = parsed.data;
  const { ip, userAgent } = await getRequestMeta();

  // (2) Rate-limit по ip и логину (§4.5). Любая блокировка → единое сообщение.
  const ipKey = `login:fail:ip:${ip ?? 'unknown'}`;
  const emailKey = `login:fail:email:${email.toLowerCase()}`;
  const [ipRate, emailRate] = await Promise.all([
    checkLoginRate(ipKey),
    checkLoginRate(emailKey),
  ]);
  if (!ipRate.allowed || !emailRate.allowed) {
    return { ok: false, message: LOGIN_ERROR };
  }

  // (3) Поиск пользователя. status проверяем после verify, чтобы не давать
  // timing-сигнал о существовании/состоянии аккаунта.
  const rows = await sql<UserAuthRow[]>`
    SELECT id, email, password_hash, status
    FROM users
    WHERE email = ${email}
    LIMIT 1
  `;
  const user = rows[0];

  // (4) Проверка пароля с timing-защитой: нет юзера → фиктивный verify (§4.4).
  const passwordOk = user
    ? await verifyPassword(user.password_hash, password)
    : await verifyDummy(password);

  // Доступ закрыт, если: нет юзера / неверный пароль / статус не active.
  const granted = Boolean(user) && passwordOk && user!.status === 'active';

  if (!granted) {
    await Promise.all([
      registerLoginFailure(ipKey),
      registerLoginFailure(emailKey),
    ]);
    // Аудит неудачи — БЕЗ пароля (§7.1). actorUserId известен только если юзер найден.
    await writeAudit(
      {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id,
        after: { email },
      },
      {
        actorUserId: user?.id,
        actorEmail: email,
        ip,
        userAgent,
      },
    );
    return { ok: false, message: LOGIN_ERROR };
  }

  // (5) Успех: сброс счётчиков, создание сессии, cookie, аудит, last_login_at.
  await Promise.all([
    resetLoginFailures(ipKey),
    resetLoginFailures(emailKey),
  ]);

  const session = await createSession(user!.id, { ip, userAgent });
  await setSessionCookie(session.id, session.expiresAt);

  await sql`UPDATE users SET last_login_at = now() WHERE id = ${user!.id}`;

  await writeAudit(
    { action: 'auth.login', entityType: 'user', entityId: user!.id },
    { actorUserId: user!.id, actorEmail: user!.email, ip, userAgent },
  );

  // redirect() бросает и прерывает выполнение (тип never).
  const { redirect } = await import('next/navigation');
  redirect('/admin');
  // Недостижимо: redirect() уже прервал выполнение. Нужно для сужения типа возврата.
  throw new Error('unreachable: redirect must have thrown');
}

// -----------------------------------------------------------------------------
// logout — выход (§4.1).
// -----------------------------------------------------------------------------

/**
 * Выход: гасит текущую сессию в БД, очищает cookie, пишет audit 'auth.logout',
 * редиректит на /admin/login.
 */
export async function logout(): Promise<void> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const sessionId = store.get(SESSION_COOKIE_NAME)?.value;
  const { ip, userAgent } = await getRequestMeta();

  if (sessionId) {
    // Узнаём actor до удаления сессии (для аудита).
    const rows = await sql<{ user_id: string; email: string }[]>`
      SELECT s.user_id, u.email
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sessionId}
      LIMIT 1
    `;
    const actor = rows[0];

    await invalidateSession(sessionId);
    await clearSessionCookie();

    await writeAudit(
      { action: 'auth.logout' },
      {
        actorUserId: actor?.user_id,
        actorEmail: actor?.email,
        ip,
        userAgent,
      },
    );
  } else {
    // Нет cookie — просто на всякий случай чистим и редиректим.
    await clearSessionCookie();
  }

  const { redirect } = await import('next/navigation');
  redirect('/admin/login');
}

// -----------------------------------------------------------------------------
// changePassword — смена пароля с ротацией сессий (§4.1, §2.2, §7.1).
// -----------------------------------------------------------------------------

/**
 * Смена пароля текущего пользователя.
 *
 * Поток:
 *   1) requireUser() — гвард (редирект, если нет сессии);
 *   2) Zod-валидация (минимальная длина нового пароля);
 *   3) verify СТАРОГО пароля против текущего хеша; неверный → ошибка;
 *   4) hash нового пароля, UPDATE users.password_hash (+ updated_at);
 *   5) ротация сессий: invalidateUserSessions(userId) — гасит ВСЕ сессии
 *      пользователя (включая текущую), требуя повторного входа.
 *   6) audit 'auth.password_change' (без паролей — санитизация в writeAudit).
 *
 * РЕШЕНИЕ ПО РОТАЦИИ: гасим ВСЕ сессии пользователя (а не «все кроме текущей»).
 * Это самый безопасный вариант после привилегированного действия (§2.2):
 * если пароль меняют из-за компрометации, активные сессии злоумышленника тоже
 * должны умереть. Цена — пользователю нужно войти заново; cookie мы тут не
 * переустанавливаем, текущая сессия становится невалидной при следующем запросе.
 */
export async function changePassword(
  raw: FormData | { oldPassword: string; newPassword: string },
): Promise<ChangePasswordResult> {
  const user = await requireUser();

  const parsed = changePasswordSchema.safeParse(
    readFields(raw, ['oldPassword', 'newPassword']),
  );
  if (!parsed.success) {
    const { fieldErrors } = parsed.error.flatten();
    return {
      ok: false,
      message: 'Проверьте корректность введённых данных',
      fieldErrors: fieldErrors as Record<string, string[]>,
    };
  }
  const { oldPassword, newPassword } = parsed.data;
  const { ip, userAgent } = await getRequestMeta();

  // (3) Проверяем старый пароль против текущего хеша.
  const rows = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${user.id} LIMIT 1
  `;
  const current = rows[0];
  if (!current || !(await verifyPassword(current.password_hash, oldPassword))) {
    return { ok: false, message: 'Текущий пароль неверен' };
  }

  // (4) Хешируем и сохраняем новый пароль.
  const newHash = await hashPassword(newPassword);
  await sql`
    UPDATE users
    SET password_hash = ${newHash}, updated_at = now()
    WHERE id = ${user.id}
  `;

  // (5) Ротация: гасим все сессии пользователя (см. РЕШЕНИЕ выше).
  await invalidateUserSessions(user.id);

  // (6) Аудит (пароли санитизируются helper-ом, §7).
  await writeAudit(
    { action: 'auth.password_change', entityType: 'user', entityId: user.id },
    { actorUserId: user.id, actorEmail: user.email, ip, userAgent },
  );

  return { ok: true };
}
