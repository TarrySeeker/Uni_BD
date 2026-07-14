/**
 * Публичный API контура customer-auth (ЛК покупателя, docs/24 §6).
 *
 * Контур ПОЛНОСТЬЮ отдельный от admin RBAC (lib/auth): свои таблицы
 * (customers += credentials, customer_sessions, customer_auth_tokens), своя
 * cookie (`admik_customer_session`), НИКАКИХ ролей/прав. Переиспользуются только
 * провайдеро-нейтральные примитивы argon2id (через ./password) и общий rate-лимитер.
 */

export * from './types';
export * from './errors';
export * from './schemas';
export {
  CUSTOMER_SESSION_COOKIE_NAME,
  CUSTOMER_SESSION_TTL_MS,
  CUSTOMER_RESET_TOKEN_TTL_MS,
  CUSTOMER_AUTH_RATE_LIMIT,
} from './constants';

export { hashPassword, verifyPassword, verifyDummy } from './password';
export { generateRawToken, hashToken, safeEqualHex } from './token';
export {
  generateCustomerSessionId,
  createCustomerSession,
  validateCustomerSession,
  invalidateCustomerSession,
  invalidateAllCustomerSessions,
} from './session';
export {
  extractCustomerSessionToken,
  setCustomerSessionCookie,
  clearCustomerSessionCookie,
} from './cookies';

export * as repository from './repository';
export {
  register,
  login,
  logout,
  getMe,
  requestPasswordReset,
  confirmPasswordReset,
  requestEmailVerification,
  confirmEmailVerification,
  updateProfile,
  getOrderHistory,
  RegistrationFailedError,
} from './service';
