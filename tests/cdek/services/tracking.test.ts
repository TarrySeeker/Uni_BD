import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты TrackingService (docs/08 §7.2).
 *
 * (а) ЧИСТЫЕ — parseStatuses, latestStatus. Без сети/БД.
 * (б) refreshStatus — мокаем repository + applyDeliveryStatus. Проверяем:
 *     маппинг статуса → delivery_status, и что недопустимый переход не
 *     применяется (applyDeliveryStatus возвращает false → transitioned=false).
 */

type ShipmentLookup = { orderId: string; cdekUuid: string } | null;
const getShipmentMock = vi.fn(
  async (): Promise<ShipmentLookup> => ({ orderId: 'ord-1', cdekUuid: 'u-1' }),
);
const updateShipmentMock = vi.fn(async () => null);
vi.mock('@/lib/cdek/repository', () => ({
  getShipmentByOrderId: (...a: unknown[]) => getShipmentMock(...(a as [])),
  getShipmentByCdekUuid: vi.fn(async () => ({ orderId: 'ord-1', cdekUuid: 'u-1' })),
  updateShipmentByOrderId: (...a: unknown[]) => updateShipmentMock(...(a as [])),
}));

// C4-2: tracking докручивает delivery_status до актуального статуса СДЭК через
// advanceDeliveryStatus (пошагово по канонической цепи), а не одношагово.
const advanceDeliveryStatusMock = vi.fn(async () => true);
vi.mock('@/lib/cdek/services/delivery-status', () => ({
  advanceDeliveryStatus: (...a: unknown[]) => advanceDeliveryStatusMock(...(a as [])),
}));

// Находка №25: pull-трекинг обязан вытаскивать и СОХРАНЯТЬ entity.cdek_number.
const saveTrackNumberMock = vi.fn(async () => true);
vi.mock('@/lib/cdek/services/track', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cdek/services/track')>();
  return {
    ...actual,
    saveTrackNumber: (...a: unknown[]) => saveTrackNumberMock(...(a as [])),
  };
});

import {
  TrackingService,
  parseStatuses,
  latestStatus,
  type TrackStatus,
} from '@/lib/cdek/services/tracking';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });

describe('cdek/tracking — parseStatuses / latestStatus (чистые)', () => {
  it('parseStatuses нормализует entity.statuses[]', () => {
    const out = parseStatuses({
      entity: {
        statuses: [
          { code: 'CREATED', name: 'Создан', date_time: '2026-06-15T10:00:00+0300' },
          { code: 'DELIVERED', name: 'Вручён', date_time: '2026-06-18T15:00:00+0300' },
        ],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[1].code).toBe('DELIVERED');
    expect(out[1].dateTime).toBeInstanceOf(Date);
  });

  it('latestStatus берёт по максимальной дате', () => {
    const statuses: TrackStatus[] = [
      { code: 'CREATED', name: 'a', dateTime: new Date('2026-06-15T10:00:00Z') },
      { code: 'DELIVERED', name: 'b', dateTime: new Date('2026-06-18T15:00:00Z') },
      { code: 'ON_THE_WAY', name: 'c', dateTime: new Date('2026-06-16T08:00:00Z') },
    ];
    expect(latestStatus(statuses)?.code).toBe('DELIVERED');
  });

  it('latestStatus без дат → последний в массиве', () => {
    const statuses: TrackStatus[] = [
      { code: 'A', name: '', dateTime: null },
      { code: 'B', name: '', dateTime: null },
    ];
    expect(latestStatus(statuses)?.code).toBe('B');
  });

  it('пустой список → null', () => {
    expect(latestStatus([])).toBeNull();
  });
});

describe('cdek/tracking — refreshStatus (mock-трекинг)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getShipmentMock.mockResolvedValue({ orderId: 'ord-1', cdekUuid: 'u-1' });
  });

  it('mock: берёт последний статус (DELIVERED) → докручивает до delivered', async () => {
    advanceDeliveryStatusMock.mockResolvedValue(true);
    const svc = new TrackingService(new CdekManager({ config: mockCfg }));
    const r = await svc.refreshStatus('ord-1');
    expect(r.statusCode).toBe('DELIVERED'); // последний в mockTrackStatuses
    expect(r.transitioned).toBe(true);
    expect(advanceDeliveryStatusMock).toHaveBeenCalledWith('ord-1', 'delivered', expect.any(String));
    expect(updateShipmentMock).toHaveBeenCalled();
  });

  it('нет применённого перехода (уже в целевом) → advanceDeliveryStatus=false → transitioned=false', async () => {
    advanceDeliveryStatusMock.mockResolvedValue(false);
    const svc = new TrackingService(new CdekManager({ config: mockCfg }));
    const r = await svc.refreshStatus('ord-1');
    expect(r.transitioned).toBe(false);
    expect(r.appliedDeliveryStatus).toBeNull();
    // но снимок статуса отправления всё равно обновлён
    expect(updateShipmentMock).toHaveBeenCalled();
  });

  it('нет отправления (cdek_uuid) → ошибка', async () => {
    getShipmentMock.mockResolvedValue(null);
    const svc = new TrackingService(new CdekManager({ config: mockCfg }));
    await expect(svc.refreshStatus('ord-1')).rejects.toThrow();
  });
});

describe('🔴 №25: cdek/tracking — боевой ответ отдаёт трек, и он сохраняется', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getShipmentMock.mockResolvedValue({ orderId: 'ord-1', cdekUuid: 'u-1' });
    advanceDeliveryStatusMock.mockResolvedValue(true);
  });

  /** Боевой (НЕ mock) CdekManager: ключи заданы, HTTP-клиент подменён ответом СДЭК. */
  function realManager(raw: unknown): CdekManager {
    const realCfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
    });
    const mgr = new CdekManager({ config: realCfg });
    expect(mgr.isMock).toBe(false);
    Object.defineProperty(mgr, 'client', {
      configurable: true,
      get: () => ({ request: async () => raw }),
    });
    return mgr;
  }

  const RAW = {
    entity: {
      uuid: 'u-1',
      cdek_number: '1106109745',
      statuses: [
        { code: 'ACCEPTED', name: 'Принят', date_time: '2026-06-16T09:00:00+0300' },
        { code: 'DELIVERED', name: 'Вручён', date_time: '2026-06-18T15:00:00+0300' },
      ],
    },
  };

  it('fetchTracking отдаёт и статусы, и cdek_number', async () => {
    const svc = new TrackingService(realManager(RAW));
    const snap = await svc.fetchTracking('u-1');
    expect(snap.statuses).toHaveLength(2);
    expect(snap.cdekNumber).toBe('1106109745');
  });

  it('refreshStatus сохраняет трек (иначе покупателю нечего показать)', async () => {
    const svc = new TrackingService(realManager(RAW));
    await svc.refreshStatus('ord-1');
    expect(saveTrackNumberMock).toHaveBeenCalledWith('ord-1', '1106109745');
  });

  it('трек ещё не присвоен → saveTrackNumber не вызывается (не затираем NULL-ом)', async () => {
    const svc = new TrackingService(
      realManager({ entity: { uuid: 'u-1', statuses: RAW.entity.statuses } }),
    );
    await svc.refreshStatus('ord-1');
    expect(saveTrackNumberMock).not.toHaveBeenCalled();
  });

  it('fetchStatuses (совместимость) продолжает работать', async () => {
    const svc = new TrackingService(realManager(RAW));
    const statuses = await svc.fetchStatuses('u-1');
    expect(statuses.map((s) => s.code)).toEqual(['ACCEPTED', 'DELIVERED']);
  });
});
