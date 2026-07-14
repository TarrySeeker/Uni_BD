/**
 * Константы контура customer-auth БЕЗ Node/БД-зависимостей (docs/24 §6).
 *
 * Имя cookie ОТДЕЛЬНОЕ от admin (`admik_session`) — покупательская сессия и
 * админская сессия не должны пересекаться ни по куке, ни по таблице.
 */

/** Имя httpOnly-cookie сессии покупателя (отдельно от admin `admik_session`). */
export const CUSTOMER_SESSION_COOKIE_NAME = 'admik_customer_session' as const;

/** Время жизни сессии покупателя: 30 дней (скользящее окно). */
export const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Порог скользящего продления: если до истечения осталось меньше половины TTL,
 * validateCustomerSession продлевает окно.
 */
export const CUSTOMER_SESSION_REFRESH_THRESHOLD_MS = CUSTOMER_SESSION_TTL_MS / 2;

/** TTL одноразового токена сброса пароля: 1 час. */
export const CUSTOMER_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * TTL одноразового токена верификации email: 24 часа. Верификация не так
 * чувствительна ко времени, как сброс пароля (не даёт смены пароля), поэтому окно
 * шире — ссылка из письма живёт сутки. sha256 в БД, одноразовость/expiry — в SQL.
 */
export const CUSTOMER_EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rate-limit ядра customer-auth (login/register/reset).
 *
 * Порог 10 попыток / 15 минут на ключ (по ip и по email отдельными вёдрами) —
 * тот же класс защиты, что и admin-логин, но СВОИ ключи (`customer:*`), чтобы
 * покупательский и админский лимиты не мешали друг другу.
 */
export const CUSTOMER_AUTH_RATE_LIMIT = {
  maxAttempts: 10,
  windowSec: 15 * 60,
} as const;
