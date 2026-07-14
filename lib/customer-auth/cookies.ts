import {
  CUSTOMER_SESSION_COOKIE_NAME,
  CUSTOMER_SESSION_TTL_MS,
} from './constants';

/**
 * Транспорт сессии покупателя (docs/24 §6) — ДВА способа, роут поддерживает оба:
 *   1) httpOnly-cookie `admik_customer_session` (SameSite; same-site витрина);
 *   2) `Authorization: Bearer <token>` (кросс-доменная/headless витрина).
 *
 * ┌─ РЕШЕНИЕ ВЛАДЕЛЬЦА (ASSUMED, docs/24 §11) ─────────────────────────────────┐
 * │ Дефолт headless-витрины: сервер на login/register ОТДАЁТ sessionToken в теле │
 * │ ответа (Bearer-поток) И одновременно ставит httpOnly-cookie SameSite=Lax     │
 * │ (same-site поток). Извлечение приоритезирует Bearer, затем cookie. Финальный  │
 * │ выбор (SameSite=Lax vs None;Secure vs только-Bearer) зависит от доменной схемы │
 * │ витрины (один домен vs кросс-домен) — открытый вопрос §11, решает владелец.   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * extractCustomerSessionToken — ЧИСТАЯ (без next/headers): читает заголовки
 * Request, тестируется без сервера. set/clear — серверная обвязка (next/headers).
 */

/** Secure-флаг включается только в проде (в dev — http://localhost). */
function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Извлекает токен сессии из запроса. Приоритет: `Authorization: Bearer <token>`
 * → cookie `admik_customer_session`. Возвращает null, если нет ни того, ни другого.
 * Чистая функция (только чтение заголовков) — без next/headers.
 */
export function extractCustomerSessionToken(req: Request): string | null {
  // 1) Bearer (кросс-домен/headless) — приоритетный.
  const authz = req.headers.get('authorization');
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m && m[1].trim()) {
      return m[1].trim();
    }
  }

  // 2) Cookie (same-site) — парсим заголовок Cookie вручную (без next/headers,
  //    чтобы функция оставалась чистой и тестируемой).
  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name === CUSTOMER_SESSION_COOKIE_NAME) {
        const value = part.slice(eq + 1).trim();
        if (value) {
          try {
            return decodeURIComponent(value);
          } catch {
            return value;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Устанавливает httpOnly-cookie сессии покупателя (серверная обвязка).
 * Импорт next/headers динамический — чтобы модуль оставался пригоден к импорту
 * из чистых юнит-тестов (они дёргают только extractCustomerSessionToken).
 */
export async function setCustomerSessionCookie(
  id: string,
  expiresAt: Date,
): Promise<void> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const maxAgeSec = Math.max(
    0,
    Math.min(
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      Math.floor(CUSTOMER_SESSION_TTL_MS / 1000),
    ),
  );
  store.set(CUSTOMER_SESSION_COOKIE_NAME, id, {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge: maxAgeSec,
  });
}

/** Очищает cookie сессии покупателя (логаут). */
export async function clearCustomerSessionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  store.set(CUSTOMER_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
