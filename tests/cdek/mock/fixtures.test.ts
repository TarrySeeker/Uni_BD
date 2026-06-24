import { describe, it, expect } from 'vitest';
import {
  mockCalculateByTariff,
  mockCalculateAvailable,
  mockGetOffices,
  mockFindOfficeByCode,
  mockCreateShipment,
  mockTrackStatuses,
  mockPrintUrl,
  MOCK_OFFICES,
  MOCK_CITY_MOSCOW,
  MOCK_CITY_SPB,
  MOCK_PRINT_URL,
} from '@/lib/cdek/mock';
import { mockDeliverySum } from '@/lib/cdek/mock/fixtures';
import type { CdekPackage } from '@/lib/cdek/types';

/**
 * Тесты mock-слоя СДЭК (docs/08 §11, §5.3, §6). Всегда зелёные, без сети.
 * Проверяем детерминированность расчёта, непустоту ПВЗ-фикстур, формат
 * фейковых uuid/трека отправления, печать.
 */

const pkg = (weight: number): CdekPackage[] => [{ weight, length: 30, width: 20, height: 10 }];

describe('cdek/mock — расчёт тарифа (формула §5.3)', () => {
  it('детерминированный: base + perKg*kg', () => {
    // 500г → 1кг: 300 + 100*1 = 400 (ПВЗ, без надбавки)
    const r = mockCalculateByTariff(136, pkg(500));
    expect(r.deliverySum).toBe('400.00');
    expect(r.tariffCode).toBe(136);
    expect(r.periodMin).toBe(2);
    expect(r.periodMax).toBe(5);
  });

  it('одинаковый вход → одинаковый результат (детерминизм)', () => {
    expect(mockCalculateByTariff(136, pkg(2500))).toEqual(mockCalculateByTariff(136, pkg(2500)));
  });

  it('курьер (тариф 137 door) дороже ПВЗ на 150', () => {
    const pvz = Number(mockCalculateByTariff(136, pkg(500)).deliverySum);
    const door = Number(mockCalculateByTariff(137, pkg(500)).deliverySum);
    expect(door - pvz).toBe(150);
  });

  it('mockDeliverySum: ceil по весу, min 1кг', () => {
    expect(mockDeliverySum(0, false)).toBe('400.00'); // min 1кг
    expect(mockDeliverySum(1001, false)).toBe('500.00'); // ceil → 2кг
    expect(mockDeliverySum(1000, true)).toBe('550.00'); // 1кг + courier 150
  });

  it('список тарифов непуст и считается по весу', () => {
    const list = mockCalculateAvailable(pkg(500));
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.map((t) => t.tariffCode)).toContain(136);
    for (const t of list) {
      expect(Number(t.deliverySum)).toBeGreaterThan(0);
    }
  });
});

describe('cdek/mock — ПВЗ (фикстуры §6)', () => {
  it('фикстуры непусты (3–5 ПВЗ)', () => {
    expect(MOCK_OFFICES.length).toBeGreaterThanOrEqual(3);
  });

  it('фильтр по городу: Москва и СПб', () => {
    expect(mockGetOffices({ cityCode: MOCK_CITY_MOSCOW }).length).toBeGreaterThan(0);
    expect(mockGetOffices({ cityCode: MOCK_CITY_SPB }).length).toBeGreaterThan(0);
    for (const o of mockGetOffices({ cityCode: MOCK_CITY_MOSCOW })) {
      expect(o.cityCode).toBe(MOCK_CITY_MOSCOW);
    }
  });

  it('фильтр по типу POSTAMAT', () => {
    const postamats = mockGetOffices({ type: 'POSTAMAT' });
    expect(postamats.length).toBeGreaterThan(0);
    for (const o of postamats) expect(o.type).toBe('POSTAMAT');
  });

  it('демо-fallback: город без фикстур (напр. Краснодар 435) всё равно даёт ≥1 ПВЗ', () => {
    const offices = mockGetOffices({ cityCode: 435 });
    expect(offices.length).toBeGreaterThan(0);
    expect(offices[0]!.cityCode).toBe(435);
    // и этот синтетический ПВЗ находится по коду (чтобы оформление не падало)
    expect(mockFindOfficeByCode(offices[0]!.code)).not.toBeNull();
  });

  it('каждый ПВЗ имеет код, адрес и координаты', () => {
    for (const o of MOCK_OFFICES) {
      expect(o.code).toBeTruthy();
      expect(o.address).toBeTruthy();
      expect(o.location).not.toBeNull();
    }
  });

  it('поиск по коду: positive и negative', () => {
    expect(mockFindOfficeByCode('MSK1')?.code).toBe('MSK1');
    expect(mockFindOfficeByCode('NOPE')).toBeNull();
  });
});

describe('cdek/mock — создание отправления', () => {
  it('фейковый uuid с префиксом mock- и трек 1+9 цифр', () => {
    const r = mockCreateShipment();
    expect(r.cdekUuid).toMatch(/^mock-[0-9a-f-]{36}$/);
    expect(r.cdekNumber).toMatch(/^1\d{9}$/);
    expect(r.isMock).toBe(true);
  });

  it('uuid уникален между вызовами', () => {
    expect(mockCreateShipment().cdekUuid).not.toBe(mockCreateShipment().cdekUuid);
  });
});

describe('cdek/mock — трекинг и печать', () => {
  it('трекинг: детерминированная цепочка до DELIVERED', () => {
    const statuses = mockTrackStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1].code).toBe('DELIVERED');
    expect(mockTrackStatuses()).toEqual(statuses); // детерминизм
  });

  it('печать: фейковый PDF-URL', () => {
    expect(mockPrintUrl()).toBe(MOCK_PRINT_URL);
    expect(mockPrintUrl()).toMatch(/^https:\/\/example\.invalid\//);
  });
});
