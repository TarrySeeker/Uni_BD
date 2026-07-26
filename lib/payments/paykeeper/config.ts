/**
 * Конфигурация модуля payments/paykeeper (docs/24 §2, порт tbank/config.ts).
 *
 * Чистое тестируемое чтение PAYKEEPER_* из окружения (через lib/config/env Zod).
 *
 * КЛЮЧЕВОЕ: `isPaykeeperMock()` — true при отсутствии PAYKEEPER_LOGIN ИЛИ
 * PAYKEEPER_PASSWORD (Basic-Auth серверного API). В mock-режиме клиент не ходит в
 * сеть, createInvoice возвращает фейковый invoice_id + внутренний demo-URL —
 * demo-магазин и CI работают без боевого эквайера.
 *
 * Два секрета PayKeeper (docs/24 §2): Basic-Auth (login/password, серверное API)
 * и секретное слово (secret, подпись колбэка). Ни один в код/фронт/логи не попадает.
 */

import { getEnv, type Env } from '@/lib/config/env';

/** Полная конфигурация модуля paykeeper (docs/24 §2). */
export interface PaykeeperConfig {
  /** Базовый URL сервера эквайринга PayKeeper. */
  baseUrl: string;
  /** Логин Basic-Auth (серверное API). Пусто → mock. */
  login: string | null;
  /** Пароль Basic-Auth (серверное API). Пусто → mock. */
  password: string | null;
  /** Секретное слово подписи колбэка (md5). */
  secret: string | null;

  /** service_name счёта (уходит в банк/чек). */
  serviceName: string;
  /** Ставка НДС позиции по умолчанию для чека. */
  defaultTax: string;
  /** Язык в service_name счёта. */
  lang: string;
  /**
   * Имя form-поля переопределения адреса возврата покупателя (штатное
   * `user_result_callback`). Пусто → поле не отправляется (см. PAYKEEPER_RETURN_PARAM).
   */
  returnParam: string | null;

  /** Доп. IP/CIDR whitelist колбэка (csv). */
  webhookAllowedIps: string[];
  /** Доверять прокси-заголовку IP (за Caddy). */
  webhookTrustProxy: boolean;

  /** Секрет cron-роутов (общий для инстанса, исторически CDEK_CRON_SECRET). */
  cronSecret: string | null;
}

/** Парсит csv строк (IP/CIDR) → массив без пустых (порт parseCsvStrings tbank). */
export function parseCsvStrings(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function nonEmpty(v: string | undefined): string | null {
  return v && v.length > 0 ? v : null;
}

/**
 * MOCK-режим (ключевая функция модуля): true, если не заданы боевые ключи
 * Basic-Auth PAYKEEPER_LOGIN/PAYKEEPER_PASSWORD (docs/24 §2). Принимает
 * опциональный source для юнит-тестов без мутации process.env (порт isTbankMock).
 */
export function isPaykeeperMock(source?: Record<string, string | undefined>): boolean {
  const env = getEnv(source ?? process.env);
  return !nonEmpty(env.PAYKEEPER_LOGIN) || !nonEmpty(env.PAYKEEPER_PASSWORD);
}

/**
 * Читает полную конфигурацию paykeeper из env. Принимает опциональный source для
 * тестируемости (как getEnv). Чистая: не кеширует, не ходит в сеть/БД.
 */
export function getPaykeeperConfig(
  source?: Record<string, string | undefined>,
): PaykeeperConfig {
  const env: Env = getEnv(source ?? process.env);
  return {
    baseUrl: env.PAYKEEPER_BASE_URL,
    login: nonEmpty(env.PAYKEEPER_LOGIN),
    password: nonEmpty(env.PAYKEEPER_PASSWORD),
    secret: nonEmpty(env.PAYKEEPER_SECRET),

    serviceName: env.PAYKEEPER_SERVICE_NAME,
    defaultTax: env.PAYKEEPER_DEFAULT_TAX,
    lang: env.PAYKEEPER_LANG,
    returnParam: nonEmpty(env.PAYKEEPER_RETURN_PARAM),

    webhookAllowedIps: parseCsvStrings(env.PAYKEEPER_WEBHOOK_IPS),
    webhookTrustProxy: env.PAYKEEPER_WEBHOOK_TRUST_PROXY,

    cronSecret: nonEmpty(env.CDEK_CRON_SECRET),
  };
}
