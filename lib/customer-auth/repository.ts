import { sql } from '@/lib/db/client';
import type { Customer, CustomerStatus } from './types';

/**
 * Слой чтения/записи контура customer-auth (docs/24 §6).
 *
 * Только параметризованный `sql` (tagged templates → анти-SQLi). password_hash
 * читается ТОЛЬКО внутренними функциями верификации (getCredentialsByEmail) и
 * никогда не попадает в доменный Customer / DTO. Маппер mapCustomer — чистый
 * (тестируется без БД), экспортируется для session.ts.
 *
 * ГРАНИЦА 7a: здесь НЕТ правки createOrder и связки гость→заказы (это 7b).
 * listCustomerOrders — только ЧТЕНИЕ orders по customer_id (для ЛК/админки),
 * order-path не трогает.
 */

// =============================================================================
// Чистый маппер row→domain.
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function asNullableDate(v: unknown): Date | null {
  return v == null ? null : asDate(v);
}

/** Маппер строки customers → доменный Customer (без password_hash). */
export function mapCustomer(row: Record<string, unknown>): Customer {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name == null ? '' : String(row.name),
    phone: row.phone == null ? null : String(row.phone),
    status: String(row.status) as CustomerStatus,
    emailVerifiedAt: asNullableDate(row.email_verified_at),
    lastLoginAt: asNullableDate(row.last_login_at),
    preferredLocale: row.preferred_locale == null ? null : String(row.preferred_locale),
    ordersCount: Number(row.orders_count ?? 0),
    totalSpent: row.total_spent == null ? '0' : String(row.total_spent),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

// Не-секретные колонки customers перечисляются в каждом запросе ЯВНО (password_hash
// исключён). Фрагмент НЕ выносится в модульную константу вида `const X = sql\`...\``:
// tagged-шаблон дёрнул бы ленивый клиент уже при импорте модуля (падение без
// DATABASE_URL в юнит-окружении). Идентификаторы статичны (не пользовательский ввод).

// =============================================================================
// Учётные данные (внутреннее — password_hash не выходит наружу).
// =============================================================================

export interface CustomerCredentials {
  id: string;
  status: CustomerStatus;
  passwordHash: string | null;
}

/**
 * Читает учётные данные по email (для логина). Возвращает password_hash ТОЛЬКО
 * для внутренней верификации — не логировать и не отдавать в DTO.
 */
export async function getCredentialsByEmail(
  email: string,
): Promise<CustomerCredentials | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, status, password_hash
    FROM customers
    WHERE email = ${email}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status) as CustomerStatus,
    passwordHash: row.password_hash == null ? null : String(row.password_hash),
  };
}

// =============================================================================
// Чтения (наружу — без секретов).
// =============================================================================

export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, email, name, phone, status,
           email_verified_at, last_login_at, preferred_locale,
           orders_count, total_spent, created_at, updated_at
    FROM customers WHERE email = ${email} LIMIT 1
  `;
  return rows[0] ? mapCustomer(rows[0]) : null;
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, email, name, phone, status,
           email_verified_at, last_login_at, preferred_locale,
           orders_count, total_spent, created_at, updated_at
    FROM customers WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapCustomer(rows[0]) : null;
}

// =============================================================================
// Регистрация / апгрейд гостя.
// =============================================================================

export interface UpgradeAccountInput {
  email: string;
  passwordHash: string;
  name?: string | null;
  preferredLocale?: string | null;
}

/**
 * Создаёт аккаунт ЛИБО апгрейдит существующего ГОСТЯ до активного аккаунта по
 * email (гость-якорь → аккаунт, docs/24 §6). UPSERT по customers_email_uniq:
 *   • email свободен → INSERT новой active-строки;
 *   • email принадлежит ГОСТЮ (status='guest', пароля нет) → апгрейд: ставим
 *     password_hash, status='active', сохраняя id и агрегаты (история заказов не
 *     рвётся);
 *   • email принадлежит УЖЕ аккаунту (status active/disabled) → WHERE отсекает
 *     UPDATE, RETURNING пуст → возвращаем null (наружу — generic «занят»).
 *
 * Пароль перезаписывается ТОЛЬКО у гостя — чужой активный аккаунт не угоняется.
 */
export async function insertOrUpgradeAccount(
  input: UpgradeAccountInput,
): Promise<Customer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO customers (email, name, password_hash, status, preferred_locale)
    VALUES (
      ${input.email},
      ${input.name ?? ''},
      ${input.passwordHash},
      'active',
      ${input.preferredLocale ?? null}
    )
    ON CONFLICT (email) DO UPDATE SET
      password_hash    = EXCLUDED.password_hash,
      status           = 'active',
      name             = CASE
                           WHEN EXCLUDED.name <> '' THEN EXCLUDED.name
                           ELSE customers.name
                         END,
      preferred_locale = COALESCE(EXCLUDED.preferred_locale, customers.preferred_locale),
      updated_at       = now()
    WHERE customers.status = 'guest'
    RETURNING id, email, name, phone, status,
              email_verified_at, last_login_at, preferred_locale,
              orders_count, total_spent, created_at, updated_at
  `;
  return rows[0] ? mapCustomer(rows[0]) : null;
}

/** Обновляет пароль (сброс) + держит аккаунт активным. Возвращает true, если строка была. */
export async function setPassword(
  customerId: string,
  passwordHash: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE customers
    SET password_hash = ${passwordHash}, status = 'active', updated_at = now()
    WHERE id = ${customerId}
    RETURNING id
  `;
  return rows.length > 0;
}

/** Фиксирует момент успешного логина. */
export async function touchLastLogin(customerId: string): Promise<void> {
  await sql`UPDATE customers SET last_login_at = now() WHERE id = ${customerId}`;
}

/** Обновляет профиль (частично). Возвращает обновлённого Customer или null. */
export interface ProfilePatch {
  name?: string | null;
  phone?: string | null;
  preferredLocale?: string | null;
}
export async function updateCustomerProfile(
  customerId: string,
  patch: ProfilePatch,
): Promise<Customer | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE customers SET
      name             = COALESCE(${patch.name ?? null}, name),
      phone            = COALESCE(${patch.phone ?? null}, phone),
      preferred_locale = COALESCE(${patch.preferredLocale ?? null}, preferred_locale),
      updated_at       = now()
    WHERE id = ${customerId}
    RETURNING id, email, name, phone, status,
              email_verified_at, last_login_at, preferred_locale,
              orders_count, total_spent, created_at, updated_at
  `;
  return rows[0] ? mapCustomer(rows[0]) : null;
}

// =============================================================================
// Одноразовые токены (сброс пароля / верификация email).
// =============================================================================

export type AuthTokenPurpose = 'password_reset' | 'email_verify';

/**
 * Создаёт одноразовый токен. Предварительно ГАСИТ прежние активные токены того же
 * назначения (used_at=now()) — свежий запрос сброса инвалидирует старые ссылки.
 * Хранится только token_hash (sha256), сырой в БД не попадает.
 */
export async function createAuthToken(input: {
  customerId: string;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await sql`
    UPDATE customer_auth_tokens
    SET used_at = now()
    WHERE customer_id = ${input.customerId}
      AND purpose = ${input.purpose}
      AND used_at IS NULL
  `;
  await sql`
    INSERT INTO customer_auth_tokens (customer_id, purpose, token_hash, expires_at)
    VALUES (${input.customerId}, ${input.purpose}, ${input.tokenHash}, ${input.expiresAt})
  `;
}

/**
 * Погашает токен АТОМАРНО и ОДНОРАЗОВО: guarded UPDATE ставит used_at только если
 * токен ещё не использован и не истёк. Возвращает customer_id при успехе, иначе
 * null (не найден / истёк / уже использован). Гонки двух запросов безопасны —
 * второй не получит строку.
 */
export async function consumeAuthToken(
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<string | null> {
  const rows = await sql<{ customer_id: string }[]>`
    UPDATE customer_auth_tokens
    SET used_at = now()
    WHERE token_hash = ${tokenHash}
      AND purpose = ${purpose}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING customer_id
  `;
  return rows[0] ? String(rows[0].customer_id) : null;
}

// =============================================================================
// Верификация email + связка гость→аккаунт (7b, docs/24 §6).
// =============================================================================

/**
 * Помечает email покупателя подтверждённым (email_verified_at). Идемпотентно:
 * первую отметку ставит now(), повторные вызовы сохраняют исходный момент
 * (COALESCE). Возвращает email покупателя (для последующей линковки заказов) или
 * null, если строки нет.
 */
export async function markEmailVerified(
  customerId: string,
): Promise<{ email: string } | null> {
  const rows = await sql<{ email: string }[]>`
    UPDATE customers
    SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
    WHERE id = ${customerId}
    RETURNING email
  `;
  return rows[0] ? { email: String(rows[0].email) } : null;
}

/**
 * Привязывает ПРОШЛЫЕ ГОСТЕВЫЕ заказы того же email к аккаунту (docs/24 §6).
 *
 * АТОМАРНО и ИДЕМПОТЕНТНО одним UPDATE: захватывает только заказы без владельца
 * (customer_id IS NULL) с совпадающим email (регистронезависимо — гостевой
 * customer_email мог прийти в любом регистре). Уже привязанные и чужие заказы НЕ
 * трогает (WHERE customer_id IS NULL). Повторный вызов после связки затрагивает 0
 * строк. Возвращает число только что привязанных заказов.
 *
 * БЕЗОПАСНОСТЬ: вызывается ТОЛЬКО из доверенного контекста (после верификации
 * email ЛИБО при регистрации, если владелец отключил верификацию) — customerId и
 * email резолвит сервер, не тело запроса. Присвоить чужую историю нельзя: линковка
 * гейтится подтверждением владения email.
 */
export async function linkGuestOrdersByEmail(
  customerId: string,
  email: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE orders
    SET customer_id = ${customerId}, updated_at = now()
    WHERE customer_id IS NULL
      AND lower(customer_email) = lower(${email})
    RETURNING id
  `;
  return rows.length;
}

// =============================================================================
// Заказы покупателя (ТОЛЬКО чтение — ЛК/админка). Границу 7b не пересекает.
// =============================================================================

export interface CustomerOrderSummary {
  number: string;
  status: string;
  paymentStatus: string;
  deliveryStatus: string;
  grandTotal: string;
  currency: string;
  createdAt: Date;
}

/** Список заказов покупателя (сводка) по customer_id. Read-only. */
export async function listCustomerOrders(
  customerId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CustomerOrderSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT number, status, payment_status, delivery_status,
           grand_total, currency, created_at
    FROM orders
    WHERE customer_id = ${customerId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((r) => ({
    number: String(r.number),
    status: String(r.status),
    paymentStatus: String(r.payment_status),
    deliveryStatus: String(r.delivery_status),
    grandTotal: r.grand_total == null ? '0' : String(r.grand_total),
    currency: String(r.currency),
    createdAt: asDate(r.created_at),
  }));
}

// =============================================================================
// Админ-поверхность (просмотр покупателей, customers.read).
// =============================================================================

export interface CustomerListRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: CustomerStatus;
  ordersCount: number;
  totalSpent: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function mapCustomerListRow(row: Record<string, unknown>): CustomerListRow {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name == null ? '' : String(row.name),
    phone: row.phone == null ? null : String(row.phone),
    status: String(row.status) as CustomerStatus,
    ordersCount: Number(row.orders_count ?? 0),
    totalSpent: row.total_spent == null ? '0' : String(row.total_spent),
    lastLoginAt: asNullableDate(row.last_login_at),
    createdAt: asDate(row.created_at),
  };
}

/** Список покупателей для админки (фильтр по подстроке email/имени/телефона). */
export async function listCustomers(
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<CustomerListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q && opts.q.trim() ? `%${opts.q.trim()}%` : null;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, email, name, phone, status, orders_count, total_spent, last_login_at, created_at
    FROM customers
    WHERE (${q}::text IS NULL OR email ILIKE ${q} OR name ILIKE ${q} OR phone ILIKE ${q})
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(mapCustomerListRow);
}

/** Общее число покупателей (для счётчика/усечения). */
export async function countCustomers(opts: { q?: string } = {}): Promise<number> {
  const q = opts.q && opts.q.trim() ? `%${opts.q.trim()}%` : null;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM customers
    WHERE (${q}::text IS NULL OR email ILIKE ${q} OR name ILIKE ${q} OR phone ILIKE ${q})
  `;
  return Number(rows[0]?.n ?? 0);
}
