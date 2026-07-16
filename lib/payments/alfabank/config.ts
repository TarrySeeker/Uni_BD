/**
 * Конфигурация модуля payments/alfabank (порт tbank/config.ts + paykeeper/config.ts).
 *
 * Чистое тестируемое чтение ALFABANK_* из окружения (через lib/config/env Zod).
 *
 * КЛЮЧЕВОЕ: `isAlfabankMock()` — true при отсутствии ALFABANK_USERNAME ИЛИ
 * ALFABANK_PASSWORD (аутентификация запросов RBS). В mock-режиме клиент не ходит в
 * сеть, register возвращает фейковый orderId + внутренний demo-URL (formUrl) —
 * demo-магазин и CI работают без боевого мерчанта.
 *
 * Секреты (username/password, callbackSecret) в код/фронт/логи не попадают —
 * только из env.
 */

import { getEnv, type Env } from '@/lib/config/env';

/** Полная конфигурация модуля alfabank. */
export interface AlfabankConfig {
  /** Базовый URL шлюза RBS (тестовый rbsuat / боевой payment.alfabank.ru). */
  gateway: string;
  /** userName API-мерчанта. Пусто → mock. */
  username: string | null;
  /** password API-мерчанта. Пусто → mock. */
  password: string | null;
  /** Секретный ключ HMAC колбэка (симметричный). Пусто → checksum не проверяется. */
  callbackSecret: string | null;

  /** Описание заказа в register.do (пусто → `Заказ <number>` в сервисе). */
  description: string | null;
  /** returnUrl / failUrl register.do (редиректы витрины). */
  returnUrl: string | null;
  failUrl: string | null;

  /** Доп. IP/CIDR whitelist колбэка (csv). */
  webhookAllowedIps: string[];
  /** Доверять прокси-заголовку IP (за Caddy). */
  webhookTrustProxy: boolean;

  /** Секрет cron-роутов (общий для инстанса, исторически CDEK_CRON_SECRET). */
  cronSecret: string | null;
}

/** Парсит csv строк (IP/CIDR) → массив без пустых (порт parseCsvStrings tbank/paykeeper). */
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
 * ALFABANK_USERNAME/ALFABANK_PASSWORD. Принимает опциональный source для юнит-тестов
 * без мутации process.env (порт isTbankMock/isPaykeeperMock).
 */
export function isAlfabankMock(source?: Record<string, string | undefined>): boolean {
  const env = getEnv(source ?? process.env);
  return !nonEmpty(env.ALFABANK_USERNAME) || !nonEmpty(env.ALFABANK_PASSWORD);
}

/**
 * Читает полную конфигурацию alfabank из env. Принимает опциональный source для
 * тестируемости (как getEnv). Чистая: не кеширует, не ходит в сеть/БД.
 */
export function getAlfabankConfig(
  source?: Record<string, string | undefined>,
): AlfabankConfig {
  const env: Env = getEnv(source ?? process.env);
  return {
    gateway: env.ALFABANK_GATEWAY,
    username: nonEmpty(env.ALFABANK_USERNAME),
    password: nonEmpty(env.ALFABANK_PASSWORD),
    callbackSecret: nonEmpty(env.ALFABANK_CALLBACK_SECRET),

    description: nonEmpty(env.ALFABANK_DESCRIPTION),
    returnUrl: nonEmpty(env.ALFABANK_RETURN_URL),
    failUrl: nonEmpty(env.ALFABANK_FAIL_URL),

    webhookAllowedIps: parseCsvStrings(env.ALFABANK_WEBHOOK_IPS),
    webhookTrustProxy: env.ALFABANK_WEBHOOK_TRUST_PROXY,

    cronSecret: nonEmpty(env.CDEK_CRON_SECRET),
  };
}
