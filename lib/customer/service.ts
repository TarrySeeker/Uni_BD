/**
 * Бизнес-логика личного кабинета: регистрация, вход, смена и восстановление
 * пароля, подтверждение адреса почты.
 *
 * ТРИ ПРАВИЛА, КОТОРЫМ ПОДЧИНЁН ВЕСЬ ФАЙЛ:
 *
 * 1. Ответ не должен выдавать, есть ли в магазине клиент с таким адресом.
 *    Ни текстом («такой email уже зарегистрирован»), ни временем ответа. Иначе
 *    любая форма кабинета превращается в проверялку чужой клиентской базы.
 *
 * 2. Ограничение попыток применяется ЗДЕСЬ, а не в отдельных роутах. В одной из
 *    прежних реализаций защиту прикрутили только к входу и регистрации, а
 *    подтверждение адреса и повторная отправка письма остались открытыми — то
 *    есть перебор токена и рассылка писем на чужой адрес.
 *
 * 3. Гостевые заказы привязываются к аккаунту ТОЛЬКО после подтверждения адреса.
 *    Ни при регистрации, ни при входе: они владения адресом не доказывают.
 */

import { hashPassword, verifyPassword, verifyDummy } from '@/lib/auth/password';
import { checkLoginRate, registerLoginFailure, resetLoginFailures } from '@/lib/auth/rate-limit';
import { getEffectiveSettings } from '@/lib/config/settings';
import { sendMail } from '@/lib/mailer';
import { logger } from '@/lib/logger';

import * as repo from './repository';
import { createCustomerSession, invalidateCustomerSessions } from './session';
import { generateRawToken, hashToken } from './token';
import {
  CUSTOMER_RESET_TOKEN_TTL_MS,
  CUSTOMER_VERIFY_TOKEN_TTL_MS,
} from './constants';
import type { CustomerAuth } from './types';
import type { RegisterInput, LoginInput, ChangePasswordInput } from './schemas';

type Meta = { ip?: string | null; userAgent?: string | null };
type Session = { token: string; expiresAt: Date };

/**
 * Ключ ограничения попыток.
 *
 * Префикс `customer:` обязателен: вёдра покупателей и сотрудников должны быть
 * раздельными, иначе всплеск покупательского трафика выбивал бы владельца из
 * админки.
 */
function rateKey(scope: string, value: string | null | undefined): string {
  return `customer:${scope}:${value ?? 'unknown'}`;
}

/** Проверяет лимит по нескольким ключам сразу (адрес почты и адрес сети). */
async function withinRateLimit(keys: string[]): Promise<boolean> {
  for (const key of keys) {
    const res = await checkLoginRate(key);
    if (!res.allowed) return false;
  }
  return true;
}

async function countFailure(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => registerLoginFailure(k)));
}

async function clearFailures(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => resetLoginFailures(k)));
}

/** Название магазина для писем — из настроек, не из кода. */
async function shopName(): Promise<string> {
  try {
    const settings = await getEffectiveSettings();
    return settings.branding?.shopName || 'Интернет-магазин';
  } catch {
    return 'Интернет-магазин';
  }
}

/**
 * Базовый адрес витрины для ссылок в письмах.
 *
 * Берётся из настроек магазина: захардкоженный домен уже уезжал в чужой магазин
 * при копировании кода, и покупатели получали ссылки на другой сайт.
 */
async function siteUrl(): Promise<string | null> {
  try {
    const settings = await getEffectiveSettings();
    return settings.seo?.site_url ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Регистрация
// -----------------------------------------------------------------------------

export type RegisterResult =
  | { ok: true; customer: CustomerAuth; session: Session }
  | { ok: false; reason: 'rate_limited' | 'failed' };

/**
 * Регистрация.
 *
 * Отказ по занятому адресу возвращается как обезличенный `failed`: сообщать
 * «адрес уже зарегистрирован» — значит подтверждать наличие клиента.
 */
export async function registerCustomer(
  input: RegisterInput,
  meta: Meta = {},
): Promise<RegisterResult> {
  const keys = [rateKey('register:ip', meta.ip), rateKey('register:email', input.email)];
  if (!(await withinRateLimit(keys))) return { ok: false, reason: 'rate_limited' };
  await countFailure(keys);

  const passwordHash = await hashPassword(input.password);
  const created = await repo.upsertRegister({
    email: input.email,
    name: input.name,
    phone: input.phone,
    passwordHash,
  });
  if (!created) return { ok: false, reason: 'failed' };

  // Письмо с подтверждением. Гостевые заказы здесь НЕ привязываем.
  await issueEmailVerification(created.id, input.email);

  const session = await createCustomerSession(created.id, meta);
  return {
    ok: true,
    customer: {
      id: created.id,
      email: input.email,
      name: input.name,
      phone: input.phone || null,
      emailVerified: false,
    },
    session,
  };
}

// -----------------------------------------------------------------------------
// Вход
// -----------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; customer: CustomerAuth; session: Session }
  | { ok: false; reason: 'rate_limited' | 'invalid' };

/**
 * Вход.
 *
 * Все причины отказа схлопнуты в `invalid`: нет аккаунта, гость без пароля,
 * неверный пароль, заблокирован — снаружи неразличимы.
 */
export async function loginCustomer(
  input: LoginInput,
  meta: Meta = {},
): Promise<LoginResult> {
  const keys = [rateKey('login:ip', meta.ip), rateKey('login:email', input.email)];
  if (!(await withinRateLimit(keys))) return { ok: false, reason: 'rate_limited' };

  const row = await repo.findAuthByEmail(input.email);

  // Аккаунта нет или это гостевая строка без пароля. Всё равно выполняем
  // проверку-пустышку: без неё отказ возвращался бы заметно быстрее, и наличие
  // клиента определялось бы по времени ответа.
  if (!row || !row.passwordHash) {
    await verifyDummy(input.password);
    await countFailure(keys);
    return { ok: false, reason: 'invalid' };
  }

  const valid = await verifyPassword(row.passwordHash, input.password);
  if (!valid || row.status !== 'active') {
    await countFailure(keys);
    return { ok: false, reason: 'invalid' };
  }

  await clearFailures(keys);
  await repo.setLastLogin(row.id);
  const session = await createCustomerSession(row.id, meta);

  return {
    ok: true,
    customer: {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      emailVerified: row.emailVerified,
    },
    session,
  };
}

// -----------------------------------------------------------------------------
// Смена пароля изнутри кабинета
// -----------------------------------------------------------------------------

export type ChangePasswordResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'wrong_current' | 'not_found' };

/**
 * Смена пароля.
 *
 * Требует текущий пароль: знания сессии недостаточно, иначе угнанная сессия
 * позволяла бы запереть владельца снаружи собственного аккаунта.
 *
 * После смены закрываются ВСЕ сессии, и тут же выдаётся новая — инициатор
 * остаётся в кабинете, а прочие устройства (включая чужие) выходят.
 */
export async function changeCustomerPassword(
  customerId: string,
  input: ChangePasswordInput,
  meta: Meta = {},
): Promise<ChangePasswordResult> {
  const row = await repo.getAuthById(customerId);
  if (!row || !row.passwordHash) return { ok: false, reason: 'not_found' };

  const valid = await verifyPassword(row.passwordHash, input.currentPassword);
  if (!valid) return { ok: false, reason: 'wrong_current' };

  await repo.updatePasswordHash(customerId, await hashPassword(input.newPassword));
  await invalidateCustomerSessions(customerId);
  const session = await createCustomerSession(customerId, meta);

  return { ok: true, session };
}

// -----------------------------------------------------------------------------
// Восстановление пароля
// -----------------------------------------------------------------------------

/**
 * Запрос ссылки восстановления.
 *
 * Ничего не возвращает намеренно: ответ одинаков и для существующего адреса, и
 * для несуществующего. Разный ответ здесь — самый простой способ выяснить,
 * зарегистрирован ли человек в магазине.
 */
export async function requestPasswordReset(email: string, meta: Meta = {}): Promise<void> {
  const keys = [rateKey('reset:ip', meta.ip), rateKey('reset:email', email)];
  if (!(await withinRateLimit(keys))) return;
  // Считаем каждую попытку, а не только неудачную: иначе массовое зондирование
  // адресов не упиралось бы в лимит вовсе.
  await countFailure(keys);

  const row = await repo.findAuthByEmail(email);
  // Гостю без пароля восстанавливать нечего — ему нужна регистрация.
  if (!row || row.status !== 'active' || !row.passwordHash) return;

  const rawToken = generateRawToken();
  await repo.createAuthToken({
    customerId: row.id,
    purpose: 'password_reset',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + CUSTOMER_RESET_TOKEN_TTL_MS),
  });

  const base = await siteUrl();
  const link = base ? `${base.replace(/\/+$/, '')}/account/reset?token=${rawToken}` : null;
  const name = await shopName();

  await sendMail({
    to: email,
    subject: `Восстановление пароля — ${name}`,
    text: link
      ? `Чтобы задать новый пароль, перейдите по ссылке: ${link}\n\n` +
        'Ссылка действует один час. Если вы не запрашивали восстановление, просто удалите это письмо.'
      : 'Запрошено восстановление пароля, но адрес сайта не настроен. Обратитесь в магазин.',
  });

  if (!link) {
    logger.warn('customer: письмо восстановления без ссылки — не задан адрес сайта в настройках');
  }
}

export type ResetConfirmResult = { ok: true } | { ok: false; reason: 'invalid_token' };

/**
 * Установка нового пароля по ссылке.
 *
 * Все сессии закрываются: если восстановление понадобилось из-за утечки, старая
 * сессия злоумышленника не должна пережить смену. Новую сессию здесь НЕ выдаём —
 * человек ещё не входил в кабинет, пусть войдёт новым паролем.
 */
export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string,
  meta: Meta = {},
): Promise<ResetConfirmResult> {
  const keys = [rateKey('reset-confirm:ip', meta.ip)];
  if (!(await withinRateLimit(keys))) return { ok: false, reason: 'invalid_token' };

  const consumed = await repo.consumeAuthToken(hashToken(rawToken), 'password_reset');
  if (!consumed) {
    // Считаем неудачу: подбор токена — это тоже перебор.
    await countFailure(keys);
    return { ok: false, reason: 'invalid_token' };
  }

  await repo.updatePasswordHash(consumed.customerId, await hashPassword(newPassword));
  await invalidateCustomerSessions(consumed.customerId);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Подтверждение адреса почты
// -----------------------------------------------------------------------------

/** Выпускает токен подтверждения и отправляет письмо (инертно без настроенной почты). */
export async function issueEmailVerification(
  customerId: string,
  email: string,
): Promise<void> {
  const rawToken = generateRawToken();
  await repo.createAuthToken({
    customerId,
    purpose: 'email_verify',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + CUSTOMER_VERIFY_TOKEN_TTL_MS),
  });

  const base = await siteUrl();
  const link = base ? `${base.replace(/\/+$/, '')}/account/verify?token=${rawToken}` : null;
  const name = await shopName();

  await sendMail({
    to: email,
    subject: `Подтверждение адреса — ${name}`,
    text: link
      ? `Подтвердите адрес электронной почты: ${link}\n\n` +
        'Ссылка действует двое суток. После подтверждения в кабинете появятся заказы, ' +
        'оформленные ранее на этот адрес.'
      : 'Подтверждение адреса недоступно: не настроен адрес сайта. Обратитесь в магазин.',
  });
}

export type VerifyResult =
  | { ok: true; linkedOrders: number }
  | { ok: false; reason: 'invalid_token' };

/**
 * Подтверждение адреса по ссылке — и ЕДИНСТВЕННОЕ место, где к аккаунту
 * привязываются гостевые заказы.
 *
 * 🔴 Почему только здесь. Соблазн привязать их при регистрации понятен, но тогда
 * достаточно зарегистрироваться на чужой адрес, чтобы получить чужие заказы:
 * адреса доставки, телефоны, состав покупок. Регистрация владения адресом не
 * доказывает — доказывает переход по ссылке из письма.
 */
export async function confirmEmailVerification(
  rawToken: string,
  meta: Meta = {},
): Promise<VerifyResult> {
  const keys = [rateKey('verify:ip', meta.ip)];
  if (!(await withinRateLimit(keys))) return { ok: false, reason: 'invalid_token' };

  const consumed = await repo.consumeAuthToken(hashToken(rawToken), 'email_verify');
  if (!consumed) {
    await countFailure(keys);
    return { ok: false, reason: 'invalid_token' };
  }

  await repo.setEmailVerified(consumed.customerId);

  const row = await repo.getAuthById(consumed.customerId);
  const linkedOrders = row
    ? await repo.linkGuestOrdersByEmail(consumed.customerId, row.email)
    : 0;

  return { ok: true, linkedOrders };
}
