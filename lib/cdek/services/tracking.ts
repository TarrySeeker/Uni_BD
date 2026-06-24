/**
 * TrackingService — pull статусов отправления (docs/08 §7.2, порт логики
 * actionSyncOrder carre).
 *
 * Выбор источника — по manager.isMock:
 *   • mock → mockTrackStatuses (детерминированная цепочка happy-path);
 *   • real → GET /v2/orders/{uuid} → entity.statuses[].
 *
 * Берём ПОСЛЕДНИЙ (актуальный) статус, маппим через status-map.mapCdekStatus,
 * обновляем cdek_shipments.status_* и orders.delivery_status (через
 * advanceDeliveryStatus — докручивает цепь ПО ШАГАМ до актуального статуса, чтобы
 * прыжок registered→delivered при потерянном in_transit не дропался молча, C4-2).
 * БД-зависимое → интеграционные тесты (skipIf); маппинг/выбор последнего статуса —
 * чистые тестируемые функции.
 */

import type { CdekManager } from '../manager';
import { getCdekManager } from '../manager';
import { CdekError } from '../errors';
import { getShipmentByOrderId, getShipmentByCdekUuid, updateShipmentByOrderId } from '../repository';
import { mapCdekStatus, displayName } from './status-map';
import { advanceDeliveryStatus } from './delivery-status';
import type { CdekShipment } from '../types';

/** Один статус трекинга (нормализованный). */
export interface TrackStatus {
  code: string;
  name: string;
  dateTime: Date | null;
}

/** Результат обновления статуса. */
export interface RefreshResult {
  /** Последний код статуса СДЭК (или null, если статусов нет). */
  statusCode: string | null;
  /** Применённый delivery_status (если переход прошёл) или null. */
  appliedDeliveryStatus: string | null;
  transitioned: boolean;
}

/** Парсит дату СДЭК (ISO8601) в Date или null. */
function parseDateTime(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Нормализует entity.statuses[] ответа СДЭК → TrackStatus[] (чистая).
 * СДЭК отдаёт статусы в массиве; самый свежий — обычно последний.
 */
export function parseStatuses(raw: unknown): TrackStatus[] {
  const entity = (raw as { entity?: { statuses?: unknown } } | undefined)?.entity;
  const arr = Array.isArray(entity?.statuses) ? (entity!.statuses as Record<string, unknown>[]) : [];
  return arr.map((s) => ({
    code: String(s.code ?? ''),
    name: typeof s.name === 'string' ? s.name : displayName(String(s.code ?? '')),
    dateTime: parseDateTime(s.date_time ?? s.dateTime),
  }));
}

/**
 * Выбирает актуальный статус из списка (чистая): по максимальной дате, при
 * отсутствии дат — последний в массиве. null для пустого списка.
 */
export function latestStatus(statuses: readonly TrackStatus[]): TrackStatus | null {
  if (statuses.length === 0) return null;
  const withDates = statuses.filter((s) => s.dateTime !== null);
  if (withDates.length > 0) {
    return withDates.reduce((a, b) =>
      (b.dateTime!.getTime() >= a.dateTime!.getTime() ? b : a),
    );
  }
  return statuses[statuses.length - 1]!;
}

export class TrackingService {
  constructor(private readonly manager: CdekManager = getCdekManager()) {}

  /** Запрашивает статусы по uuid отправления (mock/real), нормализует. */
  async fetchStatuses(cdekUuid: string): Promise<TrackStatus[]> {
    if (this.manager.isMock) {
      return this.manager.mock.mockTrackStatuses().map((s) => ({
        code: s.code,
        name: s.name,
        dateTime: parseDateTime(s.dateTime),
      }));
    }
    const raw = await this.manager.client.request<Record<string, unknown>>(
      'GET',
      `/v2/orders/${cdekUuid}`,
    );
    return parseStatuses(raw);
  }

  /**
   * Обновляет статус заказа по его id: грузит отправление, тянет статусы из СДЭК,
   * берёт актуальный, обновляет cdek_shipments + delivery_status (через статус-
   * машину). Возвращает что применилось.
   */
  async refreshStatus(orderId: string): Promise<RefreshResult> {
    const shipment = await getShipmentByOrderId(orderId);
    if (!shipment?.cdekUuid) {
      throw new CdekError(
        'cdek_no_shipment',
        `Для заказа ${orderId} нет отправления (cdek_uuid) для трекинга.`,
      );
    }
    return this.applyFromUuid(orderId, shipment.cdekUuid);
  }

  /** Обновляет статус заказа по cdek_uuid (находит заказ через shipment). */
  async refreshByCdekUuid(cdekUuid: string): Promise<RefreshResult> {
    const shipment: CdekShipment | null = await getShipmentByCdekUuid(cdekUuid);
    if (!shipment) {
      throw new CdekError('cdek_no_shipment', `Отправление с uuid ${cdekUuid} не найдено.`);
    }
    return this.applyFromUuid(shipment.orderId, cdekUuid);
  }

  private async applyFromUuid(orderId: string, cdekUuid: string): Promise<RefreshResult> {
    const statuses = await this.fetchStatuses(cdekUuid);
    const latest = latestStatus(statuses);
    if (!latest) {
      return { statusCode: null, appliedDeliveryStatus: null, transitioned: false };
    }

    await updateShipmentByOrderId(orderId, {
      statusCode: latest.code,
      statusName: latest.name || displayName(latest.code),
      statusAt: latest.dateTime ?? new Date(),
    });

    const next = mapCdekStatus(latest.code);
    let transitioned = false;
    if (next) {
      transitioned = await advanceDeliveryStatus(orderId, next, `cdek:${latest.code}`);
    }

    return {
      statusCode: latest.code,
      appliedDeliveryStatus: transitioned ? next : null,
      transitioned,
    };
  }
}
