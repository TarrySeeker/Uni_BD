/**
 * Слой доступа к данным модуля cdek (docs/08 §2 «repository.ts», §3.1 схема).
 *
 * Всё через `sql` (tagged templates → параметризация, анти-SQLi), как
 * lib/orders/repository.ts. БД-зависимое (тесты — в describe.skipIf без
 * DATABASE_URL). Покрывает:
 *   * cdek_shipments: создание/обновление, чтение по order_id/uuid;
 *   * cdek_status_log: идемпотентная запись события (ON CONFLICT DO NOTHING с
 *     вернутым признаком inserted), пометка обработанным.
 *
 * Идемпотентность webhook (docs/08 §8.3): UNIQUE (cdek_uuid, status_code,
 * status_date_time). Для событий без status_date_time подставляем to_timestamp(0)
 * (NULL в UNIQUE не конфликтует сам с собой и не ловил бы повтор).
 */

import { sql } from '@/lib/db/client';
import type {
  CdekShipment,
  CdekShipmentCreateInput,
  CdekShipmentUpdateInput,
  CdekStatusLogEntry,
  CdekStatusLogInput,
  CdekStatusLogResult,
  CdekDeliveryMode,
} from './types';

// =============================================================================
// Мапперы row→domain.
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}
function dateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : asDate(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function jsonOrNull(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** cdek_shipments row → CdekShipment. */
export function mapShipment(row: Record<string, unknown>): CdekShipment {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    cdekUuid: strOrNull(row.cdek_uuid),
    cdekNumber: strOrNull(row.cdek_number),
    tariffCode: numOrNull(row.tariff_code),
    pvzCode: strOrNull(row.pvz_code),
    cityCode: numOrNull(row.city_code),
    deliveryMode: (strOrNull(row.delivery_mode) as CdekDeliveryMode | null),
    weightG: numOrNull(row.weight_g),
    lengthCm: numOrNull(row.length_cm),
    widthCm: numOrNull(row.width_cm),
    heightCm: numOrNull(row.height_cm),
    deliverySum: strOrNull(row.delivery_sum),
    statusCode: strOrNull(row.status_code),
    statusName: strOrNull(row.status_name),
    statusAt: dateOrNull(row.status_at),
    printUrl: strOrNull(row.print_url),
    isMock: Boolean(row.is_mock),
    error: strOrNull(row.error),
    retryCount: Number(row.retry_count ?? 0),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** cdek_status_log row → CdekStatusLogEntry. */
export function mapStatusLog(row: Record<string, unknown>): CdekStatusLogEntry {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    cdekUuid: String(row.cdek_uuid),
    statusCode: String(row.status_code),
    statusName: strOrNull(row.status_name),
    statusDateTime: dateOrNull(row.status_date_time),
    cityCode: numOrNull(row.city_code),
    cityName: strOrNull(row.city_name),
    isMock: Boolean(row.is_mock),
    rawPayload: jsonOrNull(row.raw_payload),
    processed: Boolean(row.processed),
    ip: strOrNull(row.ip),
    receivedAt: asDate(row.received_at),
  };
}

// =============================================================================
// cdek_shipments — создание / обновление / чтение.
// =============================================================================

/**
 * Создаёт отправление (одно на заказ; UNIQUE order_id). При повторе для того же
 * заказа бросит ошибку уникальности — вызывающий должен проверять существование
 * (или использовать createShipment-оркестратор пакета D).
 */
export async function createShipment(
  input: CdekShipmentCreateInput,
): Promise<CdekShipment> {
  const [row] = await sql<Record<string, unknown>[]>`
    INSERT INTO cdek_shipments (
      order_id, cdek_uuid, cdek_number, tariff_code, pvz_code, city_code,
      delivery_mode, weight_g, length_cm, width_cm, height_cm, delivery_sum,
      status_code, status_name, status_at, print_url, is_mock, error
    ) VALUES (
      ${input.orderId}, ${input.cdekUuid ?? null}, ${input.cdekNumber ?? null},
      ${input.tariffCode ?? null}, ${input.pvzCode ?? null}, ${input.cityCode ?? null},
      ${input.deliveryMode ?? null}, ${input.weightG ?? null}, ${input.lengthCm ?? null},
      ${input.widthCm ?? null}, ${input.heightCm ?? null}, ${input.deliverySum ?? null},
      ${input.statusCode ?? null}, ${input.statusName ?? null}, ${input.statusAt ?? null},
      ${input.printUrl ?? null}, ${input.isMock ?? false}, ${input.error ?? null}
    )
    RETURNING *
  `;
  return mapShipment(row!);
}

/**
 * Обновляет отправление по order_id (COALESCE-патч: NULL-поля во входе → не
 * меняются). Возвращает обновлённую запись или null, если отправления нет.
 *
 * clearError=true (успешное пере-создание накладной): error СБРАСЫВАЕТСЯ в NULL и
 * retry_count в 0 ЯВНО, не через COALESCE (иначе error=null не затёр бы старый
 * текст неудачи — баг B волны 7: успешная накладная показывала ошибку прошлой
 * попытки). Без флага поведение прежнее: error через COALESCE, retry_count не трогаем.
 */
export async function updateShipmentByOrderId(
  orderId: string,
  patch: CdekShipmentUpdateInput,
): Promise<CdekShipment | null> {
  const clearError = patch.clearError ?? false;
  const [row] = await sql<Record<string, unknown>[]>`
    UPDATE cdek_shipments SET
      cdek_uuid     = COALESCE(${patch.cdekUuid ?? null}, cdek_uuid),
      cdek_number   = COALESCE(${patch.cdekNumber ?? null}, cdek_number),
      tariff_code   = COALESCE(${patch.tariffCode ?? null}, tariff_code),
      pvz_code      = COALESCE(${patch.pvzCode ?? null}, pvz_code),
      city_code     = COALESCE(${patch.cityCode ?? null}, city_code),
      delivery_mode = COALESCE(${patch.deliveryMode ?? null}, delivery_mode),
      weight_g      = COALESCE(${patch.weightG ?? null}, weight_g),
      length_cm     = COALESCE(${patch.lengthCm ?? null}, length_cm),
      width_cm      = COALESCE(${patch.widthCm ?? null}, width_cm),
      height_cm     = COALESCE(${patch.heightCm ?? null}, height_cm),
      delivery_sum  = COALESCE(${patch.deliverySum ?? null}, delivery_sum),
      status_code   = COALESCE(${patch.statusCode ?? null}, status_code),
      status_name   = COALESCE(${patch.statusName ?? null}, status_name),
      status_at     = COALESCE(${patch.statusAt ?? null}, status_at),
      print_url     = COALESCE(${patch.printUrl ?? null}, print_url),
      error         = CASE WHEN ${clearError} THEN NULL
                           ELSE COALESCE(${patch.error ?? null}, error) END,
      retry_count   = CASE WHEN ${clearError} THEN 0 ELSE retry_count END,
      updated_at    = now()
    WHERE order_id = ${orderId}
    RETURNING *
  `;
  return row ? mapShipment(row) : null;
}

/** Инкремент счётчика попыток создания + запись последней ошибки. */
export async function bumpShipmentRetry(
  orderId: string,
  error: string | null = null,
): Promise<CdekShipment | null> {
  const [row] = await sql<Record<string, unknown>[]>`
    UPDATE cdek_shipments
       SET retry_count = retry_count + 1,
           error = ${error},
           updated_at = now()
     WHERE order_id = ${orderId}
    RETURNING *
  `;
  return row ? mapShipment(row) : null;
}

/** Отправление по order_id; null если нет. */
export async function getShipmentByOrderId(
  orderId: string,
): Promise<CdekShipment | null> {
  const [row] = await sql<Record<string, unknown>[]>`
    SELECT * FROM cdek_shipments WHERE order_id = ${orderId} LIMIT 1
  `;
  return row ? mapShipment(row) : null;
}

/** Отправление по UUID СДЭК; null если нет. */
export async function getShipmentByCdekUuid(
  cdekUuid: string,
): Promise<CdekShipment | null> {
  const [row] = await sql<Record<string, unknown>[]>`
    SELECT * FROM cdek_shipments WHERE cdek_uuid = ${cdekUuid} LIMIT 1
  `;
  return row ? mapShipment(row) : null;
}

// =============================================================================
// cdek_status_log — идемпотентная запись + пометка обработанным.
// =============================================================================

/**
 * Идемпотентно пишет событие в лог (docs/08 §8.3). UNIQUE (cdek_uuid,
 * status_code, status_date_time); при отсутствии времени подставляем
 * to_timestamp(0), чтобы повтор тоже ловился. Возвращает inserted=true для
 * нового события (переход применять), inserted=false для дубликата.
 */
export async function insertStatusLog(
  input: CdekStatusLogInput,
): Promise<CdekStatusLogResult> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO cdek_status_log (
      order_id, cdek_uuid, status_code, status_name, status_date_time,
      city_code, city_name, is_mock, raw_payload, ip
    ) VALUES (
      ${input.orderId}, ${input.cdekUuid}, ${input.statusCode},
      ${input.statusName ?? null},
      COALESCE(${input.statusDateTime ?? null}::timestamptz, to_timestamp(0)),
      ${input.cityCode ?? null}, ${input.cityName ?? null}, ${input.isMock ?? false},
      ${input.rawPayload ? sql.json(input.rawPayload as Record<string, never>) : null},
      ${input.ip ?? null}
    )
    ON CONFLICT (cdek_uuid, status_code, status_date_time) DO NOTHING
    RETURNING *
  `;
  const entry = rows[0] ? mapStatusLog(rows[0]) : null;
  return { inserted: entry !== null, entry };
}

/** Помечает запись лога обработанной (переход статуса применён). */
export async function markStatusLogProcessed(id: string): Promise<void> {
  await sql`UPDATE cdek_status_log SET processed = true WHERE id = ${id}`;
}

/**
 * Находит запись лога по ключу дедупликации (cdek_uuid, status_code, status_date_time)
 * с ТОЙ ЖЕ нормализацией date_time, что insertStatusLog (null → to_timestamp(0)). Нужна
 * для переобработки после транзиентного сбоя: insertStatusLog коммитит дедуп-запись ДО
 * применения перехода; если переход упал, ретрай webhook дедуплицируется (ON CONFLICT) и
 * эффект теряется навсегда. Проверяя `processed` существующей записи, ретрай отличает
 * НАСТОЯЩИЙ дубль (processed) от недоприменённого (БАГ #10, аудит волны 15).
 */
export async function findStatusLogByKey(
  cdekUuid: string,
  statusCode: string,
  statusDateTime: Date | null,
): Promise<CdekStatusLogEntry | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM cdek_status_log
     WHERE cdek_uuid = ${cdekUuid}
       AND status_code = ${statusCode}
       AND status_date_time = COALESCE(${statusDateTime ?? null}::timestamptz, to_timestamp(0))
     LIMIT 1
  `;
  return rows[0] ? mapStatusLog(rows[0]) : null;
}

/** История событий по заказу (хронологически), для UI/аудита. */
export async function listStatusLogByOrderId(
  orderId: string,
): Promise<CdekStatusLogEntry[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM cdek_status_log
    WHERE order_id = ${orderId}
    ORDER BY received_at, id
  `;
  return rows.map(mapStatusLog);
}
