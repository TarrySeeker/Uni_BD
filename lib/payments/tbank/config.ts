/**
 * Конфигурация модуля payments/tbank (docs/15 §3 «ENV-переменные», порт
 * lib/cdek/config.ts).
 *
 * Чистое тестируемое чтение TBANK_* из окружения (через lib/config/env Zod).
 *
 * КЛЮЧЕВОЕ: `isTbankMock()` — true при отсутствии TBANK_TERMINAL_KEY ИЛИ
 * TBANK_PASSWORD (порт isCdekMock). От него зависит весь модуль: в mock-режиме
 * клиент не ходит в сеть, Init возвращает фейковый PaymentId + внутренний
 * PaymentURL (docs/15 §2.1). Позволяет demo-магазину и CI работать без боевого
 * терминала (ADR-002/ADR-011).
 */

import { getEnv, type Env } from '@/lib/config/env';
import type { TbankPayType } from './types';

/** Полная конфигурация модуля tbank (порт CdekConfig, docs/15 §3). */
export interface TbankConfig {
  baseUrl: string;
  terminalKey: string | null;
  password: string | null;

  payType: TbankPayType;

  receiptEnabled: boolean;
  taxation: string | null;
  defaultTax: string;

  notificationUrl: string | null;
  successUrl: string | null;
  failUrl: string | null;

  webhookAllowedIps: string[];
  webhookTrustProxy: boolean;

  redirectDueMin: number;
}

/** Парсит csv строк (IP/CIDR) → массив без пустых (порт parseCsvStrings СДЭК). */
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
 * TBANK_TERMINAL_KEY/TBANK_PASSWORD. Принимает опциональный source для юнит-тестов
 * без мутации process.env (порт isCdekMock).
 */
export function isTbankMock(source?: Record<string, string | undefined>): boolean {
  const env = getEnv(source ?? process.env);
  return !nonEmpty(env.TBANK_TERMINAL_KEY) || !nonEmpty(env.TBANK_PASSWORD);
}

/**
 * Читает полную конфигурацию tbank из env. Принимает опциональный source для
 * тестируемости (как getEnv). Чистая: не кеширует, не ходит в сеть/БД.
 */
export function getTbankConfig(source?: Record<string, string | undefined>): TbankConfig {
  const env: Env = getEnv(source ?? process.env);
  return {
    baseUrl: env.TBANK_BASE_URL,
    terminalKey: nonEmpty(env.TBANK_TERMINAL_KEY),
    password: nonEmpty(env.TBANK_PASSWORD),

    payType: env.TBANK_PAY_TYPE,

    receiptEnabled: env.TBANK_RECEIPT_ENABLED,
    taxation: nonEmpty(env.TBANK_TAXATION),
    defaultTax: env.TBANK_DEFAULT_TAX,

    notificationUrl: nonEmpty(env.TBANK_NOTIFICATION_URL),
    successUrl: nonEmpty(env.TBANK_SUCCESS_URL),
    failUrl: nonEmpty(env.TBANK_FAIL_URL),

    webhookAllowedIps: parseCsvStrings(env.TBANK_WEBHOOK_IPS),
    webhookTrustProxy: env.TBANK_WEBHOOK_TRUST_PROXY,

    redirectDueMin: env.TBANK_REDIRECT_DUE_MIN,
  };
}
