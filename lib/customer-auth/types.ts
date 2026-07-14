/**
 * Доменные типы контура customer-auth (ЛК покупателя, docs/24 §6).
 *
 * ПРИНЦИП: покупатель ≠ админ. Здесь НЕТ permissions/ролей/is_owner — это
 * контур идентичности покупателя, полностью отдельный от admin RBAC (lib/auth).
 */

/** Статус аккаунта покупателя (customers.status, 0044). */
export type CustomerStatus = 'guest' | 'active' | 'disabled';

/**
 * Покупатель (строка customers + учётные поля 0044). password_hash сюда НЕ
 * попадает — он читается только внутри репозитория для верификации и никогда не
 * выходит за границу сервиса/DTO.
 */
export interface Customer {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: CustomerStatus;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  preferredLocale: string | null;
  ordersCount: number;
  totalSpent: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Сессия покупателя (customer_sessions, 0045). */
export interface CustomerSession {
  id: string;
  customerId: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Метаданные запроса для аудита сессии (ip/user-agent). */
export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Результат успешного register/login: покупатель + сырой токен сессии.
 * Сырой токен возвращается ОДИН раз — вызывающий кладёт его в httpOnly-cookie
 * и/или отдаёт клиенту как Bearer. В БД (customer_sessions.id) он же и хранится
 * (как admin sessions.id) — но за пределы этого результата не логируется.
 */
export interface AuthResult {
  customer: Customer;
  sessionToken: string;
  expiresAt: Date;
}
