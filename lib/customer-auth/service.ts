import {
  checkLoginRate,
  registerLoginFailure,
  resetLoginFailures,
} from '@/lib/auth/rate-limit';
import { getLocaleConfig, resolveRequestLocale } from '@/lib/i18n';

import { hashPassword, verifyPassword, verifyDummy } from './password';
import { generateRawToken, hashToken } from './token';
import {
  createCustomerSession,
  invalidateCustomerSession,
  invalidateAllCustomerSessions,
  validateCustomerSession,
} from './session';
import {
  getCredentialsByEmail,
  getCustomerById,
  insertOrUpgradeAccount,
  setPassword,
  touchLastLogin,
  updateCustomerProfile,
  createAuthToken,
  consumeAuthToken,
  markEmailVerified,
  linkGuestOrdersByEmail,
  listCustomerOrders,
  type CustomerOrderSummary,
  type ProfilePatch,
} from './repository';
import {
  CUSTOMER_RESET_TOKEN_TTL_MS,
  CUSTOMER_EMAIL_VERIFY_TOKEN_TTL_MS,
} from './constants';
import { getEnv } from '@/lib/config/env';
import {
  InvalidCredentialsError,
  InvalidTokenError,
  RateLimitedError,
  CustomerAuthError,
} from './errors';
import type { AuthResult, Customer, SessionMeta } from './types';

/**
 * Сервис контура customer-auth (docs/24 §6) — ядро аутентификации покупателя,
 * отдельное от admin RBAC.
 *
 * БЕЗОПАСНОСТЬ (сведено здесь):
 *   • login/register/reset за rate-limit (СВОИ вёдра `customer:*`, ip+email);
 *   • login — generic InvalidCredentialsError на любой отказ (нет/неверный пароль/
 *     disabled) + verifyDummy для выравнивания времени (anti-enumeration/timing);
 *   • register при занятом активном email — generic отказ (без «email существует»);
 *   • reset-request — ВСЕГДА generic (сервис возвращает rawToken лишь для отправки
 *     письмом; роут наружу его не отдаёт и всегда отвечает одинаково);
 *   • reset-confirm — одноразовый токен (consume) + инвалидация ВСЕХ сессий;
 *   • пароль/хеш/сырой токен НЕ логируются и НЕ выходят в DTO.
 *
 * Rate-limit переиспользует общий лимитер (createRateLimiter) через тонкие
 * обёртки admin-модуля, но под ОТДЕЛЬНЫМИ ключами — контуры не смешиваются.
 */

/** Обёртка «поражение генерик-ошибкой» вместо утечки причины (register). */
export class RegistrationFailedError extends CustomerAuthError {
  constructor() {
    super('Не удалось зарегистрировать аккаунт.');
  }
}

// -----------------------------------------------------------------------------
// Rate-limit (свои ключи, ip+email).
// -----------------------------------------------------------------------------

function ipKey(scope: string, ip: string | null | undefined): string {
  return `customer:${scope}:ip:${ip ?? 'unknown'}`;
}
function emailKey(scope: string, email: string): string {
  return `customer:${scope}:email:${email}`;
}

/** Проверяет лимит по набору ключей; при блокировке — RateLimitedError. */
async function enforceRateLimit(keys: string[]): Promise<void> {
  for (const key of keys) {
    const res = await checkLoginRate(key);
    if (!res.allowed) {
      throw new RateLimitedError(res.retryAfterSec ?? 900);
    }
  }
}

async function registerFailure(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => registerLoginFailure(k)));
}

// -----------------------------------------------------------------------------
// locale.
// -----------------------------------------------------------------------------

/** Валидирует запрошенную локаль членством в shop_settings.i18n.locales. */
async function normalizePreferredLocale(
  raw: string | null | undefined,
): Promise<string | null> {
  if (raw == null) return null;
  const config = await getLocaleConfig();
  return resolveRequestLocale(raw, config);
}

// -----------------------------------------------------------------------------
// register.
// -----------------------------------------------------------------------------

export interface RegisterServiceInput {
  email: string;
  password: string;
  name?: string | null;
  preferredLocale?: string | null;
}

/**
 * Регистрирует нового покупателя ИЛИ апгрейдит гостя (по email) до аккаунта.
 * Занятый активный email → RegistrationFailedError (generic, без утечки). Успех →
 * создаёт сессию и возвращает AuthResult (customer + токен сессии).
 */
export async function register(
  input: RegisterServiceInput,
  meta: SessionMeta = {},
): Promise<AuthResult> {
  const keys = [ipKey('register', meta.ip)];
  await enforceRateLimit(keys);

  const preferredLocale = await normalizePreferredLocale(input.preferredLocale);
  const passwordHash = await hashPassword(input.password);

  const customer = await insertOrUpgradeAccount({
    email: input.email,
    passwordHash,
    name: input.name ?? '',
    preferredLocale,
  });

  if (!customer) {
    // Email уже принадлежит активному аккаунту → generic (счётчик +1 против абуза).
    await registerFailure(keys);
    throw new RegistrationFailedError();
  }

  // Линковка прошлых ГОСТЕВЫХ заказов того же email к аккаунту (docs/24 §6).
  // ГЕЙТ (решение владельца §11, дефолт ASSUMED): по умолчанию линкуем ТОЛЬКО
  // после подтверждения email (confirmEmailVerification) — закрывает account-
  // takeover (first-to-register с чужим email). Если владелец ЯВНО отключил
  // верификацию (CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false) — привязываем сразу
  // при регистрации/апгрейде гостя (магазин доверяет владению email на чекауте).
  if (!getEnv().CUSTOMER_EMAIL_VERIFICATION_REQUIRED) {
    await linkGuestOrdersByEmail(customer.id, customer.email);
  }

  await touchLastLogin(customer.id);
  const session = await createCustomerSession(customer.id, meta);
  return {
    customer: { ...customer, lastLoginAt: new Date() },
    sessionToken: session.id,
    expiresAt: session.expiresAt,
  };
}

// -----------------------------------------------------------------------------
// login.
// -----------------------------------------------------------------------------

export interface LoginServiceInput {
  email: string;
  password: string;
}

/**
 * Логин: единый InvalidCredentialsError на любой отказ (anti-enumeration).
 * verifyDummy выравнивает время при отсутствии аккаунта/пароля. Успех сбрасывает
 * счётчик неудач, обновляет last_login_at и создаёт сессию.
 */
export async function login(
  input: LoginServiceInput,
  meta: SessionMeta = {},
): Promise<AuthResult> {
  const keys = [ipKey('login', meta.ip), emailKey('login', input.email)];
  await enforceRateLimit(keys);

  const creds = await getCredentialsByEmail(input.email);

  // Нет аккаунта / нет пароля (чистый гость) / не активен → выравниваем время и
  // отвечаем ЕДИНЫМ отказом (не раскрываем, что именно не так).
  if (!creds || creds.passwordHash === null || creds.status !== 'active') {
    await verifyDummy(input.password);
    await registerFailure(keys);
    throw new InvalidCredentialsError();
  }

  const ok = await verifyPassword(creds.passwordHash, input.password);
  if (!ok) {
    await registerFailure(keys);
    throw new InvalidCredentialsError();
  }

  await resetLoginFailures(keys[0]);
  await resetLoginFailures(keys[1]);
  await touchLastLogin(creds.id);

  const customer = await getCustomerById(creds.id);
  if (!customer) {
    // Практически недостижимо (только что читали creds) — защитная ветка.
    throw new InvalidCredentialsError();
  }

  const session = await createCustomerSession(customer.id, meta);
  return {
    customer: { ...customer, lastLoginAt: new Date() },
    sessionToken: session.id,
    expiresAt: session.expiresAt,
  };
}

// -----------------------------------------------------------------------------
// logout / me.
// -----------------------------------------------------------------------------

/** Логаут: инвалидирует конкретную сессию. Идемпотентно (нет токена → no-op). */
export async function logout(sessionToken: string | null): Promise<void> {
  if (!sessionToken) return;
  await invalidateCustomerSession(sessionToken);
}

/** Текущий покупатель по токену сессии (null — нет/невалидна/истекла). */
export async function getMe(sessionToken: string | null): Promise<Customer | null> {
  if (!sessionToken) return null;
  return validateCustomerSession(sessionToken);
}

// -----------------------------------------------------------------------------
// password reset.
// -----------------------------------------------------------------------------

export interface ResetRequestResult {
  /** Сырой токен для отправки письмом. null — аккаунта нет (роут этого не раскрывает). */
  rawToken: string | null;
}

/**
 * Запрос сброса пароля. ВСЕГДА завершается «успешно» для вызывающего (роут
 * отвечает generic 200 независимо от наличия email — anti-enumeration). Если
 * активный аккаунт есть — создаёт одноразовый токен (TTL 1ч), гасит прежние, и
 * возвращает сырой токен ДЛЯ ПИСЬМА (наружу в HTTP не отдаётся).
 */
export async function requestPasswordReset(
  email: string,
  meta: SessionMeta = {},
): Promise<ResetRequestResult> {
  const keys = [ipKey('reset', meta.ip), emailKey('reset', email)];
  await enforceRateLimit(keys);
  await registerFailure(keys); // считаем каждую попытку (щит от массового зондирования)

  const creds = await getCredentialsByEmail(email);
  if (!creds || creds.status !== 'active') {
    return { rawToken: null };
  }

  const rawToken = generateRawToken();
  await createAuthToken({
    customerId: creds.id,
    purpose: 'password_reset',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + CUSTOMER_RESET_TOKEN_TTL_MS),
  });
  return { rawToken };
}

/**
 * Подтверждение сброса: погашает одноразовый токен, ставит новый пароль,
 * ИНВАЛИДИРУЕТ ВСЕ сессии покупателя (выход со всех устройств). Недействительный/
 * истёкший/использованный токен → InvalidTokenError.
 */
export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string,
  meta: SessionMeta = {},
): Promise<void> {
  await enforceRateLimit([ipKey('reset-confirm', meta.ip)]);

  const customerId = await consumeAuthToken(hashToken(rawToken), 'password_reset');
  if (!customerId) {
    await registerFailure([ipKey('reset-confirm', meta.ip)]);
    throw new InvalidTokenError();
  }

  const passwordHash = await hashPassword(newPassword);
  await setPassword(customerId, passwordHash);
  await invalidateAllCustomerSessions(customerId);
}

// -----------------------------------------------------------------------------
// email verification (double opt-in + связка гость→аккаунт, docs/24 §6).
// -----------------------------------------------------------------------------

export interface EmailVerifyRequestResult {
  /** Сырой токен для отправки письмом. null — активного аккаунта нет (роут не раскрывает). */
  rawToken: string | null;
}

/**
 * Запрос верификации email. ВСЕГДА завершается «успешно» для вызывающего (роут
 * отвечает generic 200 независимо от наличия email — anti-enumeration). Если
 * активный аккаунт есть — создаёт одноразовый токен (TTL 24ч, sha256 в БД), гасит
 * прежние email_verify-токены и возвращает сырой токен ДЛЯ ПИСЬМА (наружу в HTTP не
 * отдаётся). По образцу requestPasswordReset (7a).
 */
export async function requestEmailVerification(
  email: string,
  meta: SessionMeta = {},
): Promise<EmailVerifyRequestResult> {
  const keys = [ipKey('verify', meta.ip), emailKey('verify', email)];
  await enforceRateLimit(keys);
  await registerFailure(keys); // считаем каждую попытку (щит от массового зондирования)

  const creds = await getCredentialsByEmail(email);
  if (!creds || creds.status !== 'active') {
    return { rawToken: null };
  }

  const rawToken = generateRawToken();
  await createAuthToken({
    customerId: creds.id,
    purpose: 'email_verify',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + CUSTOMER_EMAIL_VERIFY_TOKEN_TTL_MS),
  });
  return { rawToken };
}

export interface EmailVerifyConfirmResult {
  /** Сколько прошлых гостевых заказов привязано к аккаунту после верификации. */
  linkedOrders: number;
}

/**
 * Подтверждение владения email: погашает ОДНОРАЗОВЫЙ токен (consume — атомарно,
 * с учётом expiry), ставит customers.email_verified_at и — ГЛАВНОЕ (docs/24 §6) —
 * привязывает прошлые ГОСТЕВЫЕ заказы того же email к аккаунту
 * (linkGuestOrdersByEmail). Недействительный/истёкший/использованный токен →
 * InvalidTokenError. customerId и email резолвит СЕРВЕР (из токена), не тело.
 */
export async function confirmEmailVerification(
  rawToken: string,
  meta: SessionMeta = {},
): Promise<EmailVerifyConfirmResult> {
  await enforceRateLimit([ipKey('verify-confirm', meta.ip)]);

  const customerId = await consumeAuthToken(hashToken(rawToken), 'email_verify');
  if (!customerId) {
    await registerFailure([ipKey('verify-confirm', meta.ip)]);
    throw new InvalidTokenError();
  }

  const marked = await markEmailVerified(customerId);
  if (!marked) {
    // Практически недостижимо (токен ссылается на существующего customer через FK).
    throw new InvalidTokenError();
  }

  const linkedOrders = await linkGuestOrdersByEmail(customerId, marked.email);
  return { linkedOrders };
}

// -----------------------------------------------------------------------------
// profile / orders.
// -----------------------------------------------------------------------------

export async function updateProfile(
  customerId: string,
  patch: ProfilePatch,
): Promise<Customer | null> {
  const preferredLocale =
    patch.preferredLocale !== undefined
      ? await normalizePreferredLocale(patch.preferredLocale)
      : undefined;
  return updateCustomerProfile(customerId, { ...patch, preferredLocale });
}

export async function getOrderHistory(
  customerId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CustomerOrderSummary[]> {
  return listCustomerOrders(customerId, opts);
}
