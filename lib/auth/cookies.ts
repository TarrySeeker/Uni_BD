// СЕРВЕРНЫЙ МОДУЛЬ ('server-only' семантика): импортирует next/headers `cookies()`,
// доступный только в серверном окружении Next (Server Components / Server Actions /
// route handlers). НЕ импортировать из клиентского кода и из чистых юнит-тестов.
// (Пакет `server-only` как hard-зависимость не вводим — маркер задан семантикой/доками.)
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '@/lib/auth/session';

/**
 * Хелперы установки/очистки cookie сессии (docs/04 §4.6).
 *
 * Серверный модуль (`server-only`): импортирует next/headers `cookies()`,
 * доступный только в серверных компонентах / Server Actions / route handlers.
 * НЕ импортируйте его из клиентского кода и из чистых юнит-тестов.
 *
 * Флаги cookie (§4.6):
 *   * httpOnly        — недоступна из JS (защита от XSS-кражи токена);
 *   * Secure          — только по HTTPS в проде (по NODE_ENV);
 *   * SameSite=Lax    — защита от CSRF, но навигационные GET проходят;
 *   * Path=/          — кука действует на весь сайт (включая /admin/*);
 *   * maxAge/expires  — срок жизни = окно сессии (expires_at).
 */

/** Secure-флаг включается только в проде (в dev — http://localhost). */
function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Устанавливает cookie сессии после успешного логина / продления.
 * `maxAge` берётся из срока жизни сессии (expires_at), но не больше TTL.
 */
export async function setSessionCookie(
  id: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies();
  // maxAge в секундах: до истечения сессии, но не отрицательный.
  const maxAgeSec = Math.max(
    0,
    Math.min(
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      Math.floor(SESSION_TTL_MS / 1000),
    ),
  );

  store.set(SESSION_COOKIE_NAME, id, {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge: maxAgeSec,
  });
}

/**
 * Очищает cookie сессии (логаут / инвалидация).
 * Перетираем пустым значением с maxAge=0, чтобы браузер удалил куку.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
