/**
 * Доменные типы модуля cdek (docs/08 §2 «types.ts», §3 «Схема БД»).
 *
 * Прикладной уровень (camelCase), отображающий строки cdek_shipments /
 * cdek_status_log (миграция 0017) и контракты СДЭК (тариф/ПВЗ/расчёт/габариты).
 * Маппинг row(snake_case)→domain(camelCase) — в repository.ts.
 *
 * Деньги моделируются строкой (NUMERIC(14,2) приходит из postgres.js строкой,
 * чтобы не терять точность) — как в lib/orders/types.ts. Вес — граммы (int),
 * габариты — сантиметры (int).
 */

import type { DeliveryStatus } from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Перечисления / литеральные типы.
// -----------------------------------------------------------------------------

/** Режим доставки получателю (cdek_shipments.delivery_mode). */
export type CdekDeliveryMode = 'pvz' | 'postamat' | 'door';
export const CDEK_DELIVERY_MODES: readonly CdekDeliveryMode[] = [
  'pvz',
  'postamat',
  'door',
] as const;

/**
 * Категория статуса СДЭК (0–5, как carre StatusMap). Маппится в DeliveryStatus
 * Admik (см. status-map.ts, пакет C):
 *   1 → registered, 2/3 → in_transit, 4 → delivered, 5 → returned|cancelled.
 */
export type CdekStatusCategory = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Известные коды статусов СДЭК (подмножество; полная таблица — в status-map.ts).
 * Тип нестрогий (string), но перечисление документирует ожидаемые значения.
 */
export type CdekStatusCode =
  | 'CREATED'
  | 'ACCEPTED'
  | 'RECEIVED_AT_SHIPMENT_WAREHOUSE'
  | 'ON_THE_WAY'
  | 'SENT_TO_RECIPIENT_CITY'
  | 'ACCEPTED_AT_PICK_UP_POINT'
  | 'READY_FOR_PICKUP'
  | 'TAKEN_BY_COURIER'
  | 'DELIVERED'
  | 'NOT_DELIVERED'
  | 'RETURNED_TO_SENDER'
  | 'LOST'
  | 'INVALID'
  | 'CANCELLED'
  | (string & {});

// -----------------------------------------------------------------------------
// Габариты упаковки (вес/размеры).
// -----------------------------------------------------------------------------

/**
 * Габариты упаковки: вес в граммах, размеры в сантиметрах. Используется и как
 * дефолт магазина (config.ts), и как снимок на отправлении (cdek_shipments).
 */
export interface PackageDims {
  weightG: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

// -----------------------------------------------------------------------------
// Контракты СДЭК (расчёт / тариф / ПВЗ). Минимальный набор для пакета A.
// -----------------------------------------------------------------------------

/** Локация для расчёта/создания (код города ИЛИ индекс/адрес). */
export interface CdekLocation {
  code?: number;
  postalCode?: string;
  address?: string;
}

/** Упаковка для запроса расчёта/создания (вес обязателен; размеры опц.). */
export interface CdekPackage {
  weight: number; // граммы
  length?: number; // см
  width?: number; // см
  height?: number; // см
}

/** Результат расчёта по конкретному тарифу (POST /v2/calculator/tariff). */
export interface CdekTariffResult {
  /** Стоимость доставки (строка NUMERIC, как деньги в orders). */
  deliverySum: string;
  periodMin: number | null;
  periodMax: number | null;
  tariffCode: number;
}

/** Вариант тарифа из списка (POST /v2/calculator/tarifflist). */
export interface CdekTariffOption {
  tariffCode: number;
  tariffName: string | null;
  deliverySum: string;
  periodMin: number | null;
  periodMax: number | null;
  deliveryMode: number | null;
}

/** Пункт выдачи заказов (GET /v2/deliverypoints). */
export interface CdekOffice {
  code: string;
  name: string;
  address: string;
  type: string; // PVZ | POSTAMAT
  cityCode: number | null;
  location: { latitude: number; longitude: number } | null;
  workTime: string | null;
}

/** Город СДЭК (GET /v2/location/cities) — для автокомплита города на витрине. */
export interface CdekCity {
  /** Код города СДЭК (нужен для расчёта/ПВЗ). */
  code: number;
  name: string;
  region: string;
}

// -----------------------------------------------------------------------------
// Сущности БД (миграция 0017).
// -----------------------------------------------------------------------------

/** Отправление СДЭК (cdek_shipments). 1:1 к заказу. */
export interface CdekShipment {
  id: string;
  orderId: string;

  /** UUID отправления в СДЭК; null до создания. */
  cdekUuid: string | null;
  /** Трек-номер (cdek_number); null до создания. */
  cdekNumber: string | null;
  tariffCode: number | null;
  pvzCode: string | null;
  cityCode: number | null;
  deliveryMode: CdekDeliveryMode | null;

  // Снимок габаритов на момент создания (вес — г, размеры — см).
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;

  /** Стоимость доставки (строка NUMERIC(14,2)); null → не рассчитана. */
  deliverySum: string | null;

  statusCode: string | null;
  statusName: string | null;
  statusAt: Date | null;

  printUrl: string | null;
  isMock: boolean;
  error: string | null;
  retryCount: number;

  createdAt: Date;
  updatedAt: Date;
}

/** Запись лога входящих событий webhook (cdek_status_log). */
export interface CdekStatusLogEntry {
  id: string;
  orderId: string;
  cdekUuid: string;
  statusCode: string;
  statusName: string | null;
  statusDateTime: Date | null;
  cityCode: number | null;
  cityName: string | null;
  isMock: boolean;
  rawPayload: Record<string, unknown> | null;
  processed: boolean;
  ip: string | null;
  receivedAt: Date;
}

// -----------------------------------------------------------------------------
// Входные DTO для репозитория (создание/обновление/запись лога).
// -----------------------------------------------------------------------------

/** Поля для создания отправления (всё опц., кроме orderId). */
export interface CdekShipmentCreateInput {
  orderId: string;
  cdekUuid?: string | null;
  cdekNumber?: string | null;
  tariffCode?: number | null;
  pvzCode?: string | null;
  cityCode?: number | null;
  deliveryMode?: CdekDeliveryMode | null;
  weightG?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  deliverySum?: string | null;
  statusCode?: string | null;
  statusName?: string | null;
  statusAt?: Date | null;
  printUrl?: string | null;
  isMock?: boolean;
  error?: string | null;
}

/** Патч для обновления отправления (только переданные поля). */
export interface CdekShipmentUpdateInput {
  cdekUuid?: string | null;
  cdekNumber?: string | null;
  tariffCode?: number | null;
  pvzCode?: string | null;
  cityCode?: number | null;
  deliveryMode?: CdekDeliveryMode | null;
  weightG?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  deliverySum?: string | null;
  statusCode?: string | null;
  statusName?: string | null;
  statusAt?: Date | null;
  printUrl?: string | null;
  error?: string | null;
  /**
   * Явный сброс ошибки и счётчика попыток (успешное пере-создание накладной).
   * COALESCE(error) сам по себе НЕ затирает старую ошибку при error=null, поэтому
   * для успеха нужен явный флаг: error=NULL и retry_count=0. По умолчанию false —
   * прежнее поведение (COALESCE-патч, retry_count не трогаем).
   */
  clearError?: boolean;
}

/** Поля для записи события в cdek_status_log (идемпотентная вставка). */
export interface CdekStatusLogInput {
  orderId: string;
  cdekUuid: string;
  statusCode: string;
  statusName?: string | null;
  /** Время статуса; null → репозиторий подставит to_timestamp(0) (для UNIQUE). */
  statusDateTime?: Date | null;
  cityCode?: number | null;
  cityName?: string | null;
  isMock?: boolean;
  rawPayload?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Результат идемпотентной вставки в лог: inserted=true → новое событие;
 * inserted=false → дубликат (повторный webhook), переход применять не нужно.
 */
export interface CdekStatusLogResult {
  inserted: boolean;
  entry: CdekStatusLogEntry | null;
}

// Реэкспорт для удобства потребителей status-map (пакет C).
export type { DeliveryStatus };
