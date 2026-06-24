/**
 * Константы auth БЕЗ Node/БД-зависимостей — пригодны для Edge Runtime
 * (middleware) и любого окружения.
 *
 * Вынесено отдельно, чтобы middleware (Edge) мог импортировать имя cookie,
 * НЕ затягивая в edge-бандл `lib/auth/session.ts` (тот тянет node:crypto и
 * клиент postgres, недоступные в Edge Runtime).
 */

/** Имя cookie сессии (docs/04 §4.6). */
export const SESSION_COOKIE_NAME = 'admik_session' as const;

/** Время жизни сессии: 30 дней (скользящее окно, §4.6). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
