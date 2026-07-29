/**
 * Конфигурация модуля cdek (docs/08 §2 «config.ts», §13.2 env).
 *
 * Чистое, тестируемое чтение CDEK_* из окружения (через lib/config/env Zod) +
 * настроек магазина (отправитель, тариф, габариты по умолчанию, IP-whitelist).
 *
 * КЛЮЧЕВОЕ: `isCdekMock()` — true при отсутствии CDEK_ACCOUNT/CDEK_SECRET. От
 * него зависит весь модуль: в mock-режиме клиент не ходит в сеть, расчёт идёт по
 * формуле, ПВЗ — из фикстур (см. docs/08 §11). Это позволяет demo-магазину и CI
 * работать без боевых ключей (ADR-002).
 */

import { getEnv, type Env } from '@/lib/config/env';
import type { PackageDims, CdekDeliveryMode } from './types';

/** Конфигурация отправителя (CDEK_SENDER_*). */
export interface CdekSenderConfig {
  name: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  inn: string | null;
}

/** Полная конфигурация модуля cdek (порт CdekConfig, docs/08 §2.1). */
export interface CdekConfig {
  baseUrl: string;
  account: string | null;
  secret: string | null;
  testMode: boolean;

  fromLocationCode: number;
  shipmentPoint: string | null;

  /** Тариф ПВЗ/постамата (склад-склад, дефолт 136). */
  defaultTariffCode: number;
  /** Тариф курьерской доставки «до двери» (склад-дверь, дефолт 137). */
  doorTariffCode: number;
  allowedTariffs: number[];

  sender: CdekSenderConfig;

  defaultDimensions: PackageDims;

  webhookSecret: string | null;
  webhookAllowedIps: string[];
  webhookTrustProxy: boolean;

  cronSecret: string | null;
  createEnabled: boolean;

  /**
   * Окно (часы) поиска заказов на авто-создание накладной, от МОМЕНТА ОПЛАТЫ
   * (аудит #17). Всегда положительное: невалидный env → дефолт.
   */
  createWindowHours: number;
  /** Окно (часы) отчёта о «зависших» заказах без накладной (покрывает окно создания). */
  stuckWindowHours: number;
}

/**
 * Дефолтное окно создания накладной — 30 суток (аудит-находка #17).
 *
 * ПОЧЕМУ НЕ 24 ЧАСА. Прежнее жёсткое «created_at > now() - 24 hours» означало:
 * заказ, оплаченный на вторые сутки (банковский перевод, подтверждение вручную,
 * сутки простоя крона), не попадал в выборку УЖЕ НИКОГДА — накладная не
 * создавалась молча.
 *
 * ПОЧЕМУ НЕ «ВСЯ ИСТОРИЯ». Окно обязано остаться конечным: магазин, переехавший
 * с историей заказов (на стенде 288 легаси-записей), при бесконечной выборке
 * разом отправил бы старые оплаченные заказы в СДЭК. Тот же класс аварии, что у
 * уборщика неоплаченных заказов (ORDERS_UNPAID_TTL_MINUTES=0 по умолчанию).
 * 30 суток с запасом покрывают любую отложенную оплату и отсекают легаси.
 */
export const CDEK_CREATE_WINDOW_HOURS_DEFAULT = 720;

/** Дефолтное окно отчёта о «зависших» — равно окну создания (не уже него). */
export const CDEK_STUCK_WINDOW_HOURS_DEFAULT = CDEK_CREATE_WINDOW_HOURS_DEFAULT;

/**
 * Нормализует окно (часы) из настройки: только конечное положительное целое;
 * иначе — дефолт. Ноль/отрицательное НЕ означает «без ограничения» (это была бы
 * выборка по всей истории — см. риск легаси выше).
 */
export function resolveWindowHours(raw: number | undefined | null, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.trunc(raw);
}

/**
 * Хардкод-фоллбэк габаритов последней инстанции (если и env пуст). Крупнее
 * carre fallback-ключа (250/28/28/6) под автотовары Gang Auto (docs/08 §3.3).
 */
export const CDEK_FALLBACK_DIMENSIONS: PackageDims = {
  weightG: 500,
  lengthCm: 30,
  widthCm: 20,
  heightCm: 10,
};

/** Парсит csv «1,2 ,3» → [1,2,3]; пустые/нечисловые отбрасывает. */
export function parseCsvInts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/** Парсит csv строк (IP/CIDR, домены) → массив без пустых. */
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
 * CDEK_ACCOUNT/CDEK_SECRET. Принимает опциональный source для юнит-тестов без
 * мутации process.env.
 */
export function isCdekMock(source?: Record<string, string | undefined>): boolean {
  const env = getEnv(source ?? process.env);
  return !nonEmpty(env.CDEK_ACCOUNT) || !nonEmpty(env.CDEK_SECRET);
}

/** Собирает конфигурацию отправителя из env. */
function buildSender(env: Env): CdekSenderConfig {
  return {
    name: nonEmpty(env.CDEK_SENDER_NAME),
    contactName: nonEmpty(env.CDEK_SENDER_CONTACT_NAME),
    phone: nonEmpty(env.CDEK_SENDER_PHONE),
    email: nonEmpty(env.CDEK_SENDER_EMAIL),
    inn: nonEmpty(env.CDEK_SENDER_INN),
  };
}

/** Дефолтные габариты упаковки из env (с фоллбэком, docs/08 §3.3). */
function buildDefaultDimensions(env: Env): PackageDims {
  return {
    weightG: env.CDEK_DEFAULT_WEIGHT_G,
    lengthCm: env.CDEK_DEFAULT_LENGTH_CM,
    widthCm: env.CDEK_DEFAULT_WIDTH_CM,
    heightCm: env.CDEK_DEFAULT_HEIGHT_CM,
  };
}

/**
 * Читает полную конфигурацию cdek из env. Принимает опциональный source для
 * тестируемости (как getEnv). Чистая: не кеширует, не ходит в сеть/БД.
 */
export function getCdekConfig(source?: Record<string, string | undefined>): CdekConfig {
  const env = getEnv(source ?? process.env);
  return {
    baseUrl: env.CDEK_BASE_URL,
    account: nonEmpty(env.CDEK_ACCOUNT),
    secret: nonEmpty(env.CDEK_SECRET),
    testMode: env.CDEK_TEST_MODE,

    fromLocationCode: env.CDEK_FROM_LOCATION_CODE,
    shipmentPoint: nonEmpty(env.CDEK_SHIPMENT_POINT),

    defaultTariffCode: env.CDEK_DEFAULT_TARIFF,
    doorTariffCode: env.CDEK_DOOR_TARIFF,
    allowedTariffs: parseCsvInts(env.CDEK_ALLOWED_TARIFFS),

    sender: buildSender(env),

    defaultDimensions: buildDefaultDimensions(env),

    webhookSecret: nonEmpty(env.CDEK_WEBHOOK_SECRET),
    webhookAllowedIps: parseCsvStrings(env.CDEK_WEBHOOK_IPS),
    webhookTrustProxy: env.CDEK_WEBHOOK_TRUST_PROXY,

    cronSecret: nonEmpty(env.CDEK_CRON_SECRET),
    createEnabled: env.CDEK_CREATE_ENABLED,

    createWindowHours: resolveWindowHours(
      env.CDEK_CREATE_WINDOW_HOURS,
      CDEK_CREATE_WINDOW_HOURS_DEFAULT,
    ),
    // Окно «зависших» не должно быть уже окна создания: иначе заказ, выпавший из
    // создания, не попадёт и в отчёт — то есть исчезнет молча (ровно баг #17).
    stuckWindowHours: Math.max(
      resolveWindowHours(env.CDEK_STUCK_WINDOW_HOURS, CDEK_STUCK_WINDOW_HOURS_DEFAULT),
      resolveWindowHours(env.CDEK_CREATE_WINDOW_HOURS, CDEK_CREATE_WINDOW_HOURS_DEFAULT),
    ),
  };
}

/**
 * Тариф СДЭК по режиму доставки (M4): курьер «до двери» (door) → doorTariffCode
 * (склад-дверь, 137); ПВЗ/постамат → defaultTariffCode (склад-склад, 136).
 *
 * Раньше тариф был mode-agnostic (всегда defaultTariffCode) → курьерская доставка
 * тарифицировалась ПВЗ-тарифом. Чистая и конфигурируемая (коды — из env, не зашиты
 * под конкретный магазин): мультитенантно переносится на любой ИМ.
 */
export function tariffForMode(
  cfg: CdekConfig,
  mode: CdekDeliveryMode | undefined,
): number {
  return mode === 'door' ? cfg.doorTariffCode : cfg.defaultTariffCode;
}
