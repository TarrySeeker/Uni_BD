/**
 * Mock-реализации операций СДЭК (docs/08 §11 «Mock-режим целиком»).
 *
 * Чистые/детерминированные функции, помеченные `isMock: true`. Покрывают всё,
 * что понадобится сервисам пакета C+ (Calculator/Pvz/Order/Tracking/Print):
 *   • расчёт тарифа по весу/режиму (формула §5.3);
 *   • список доступных тарифов (фикстурный набор);
 *   • список ПВЗ/постаматов с фильтрами (фикстуры §6);
 *   • создание отправления (фейковый uuid + трек);
 *   • трекинг (последовательность статусов);
 *   • печать (фейковый PDF-URL).
 *
 * Это то, что demo-магазин и тесты используют БЕЗ боевых ключей (docs/02). Сети
 * здесь нет вообще. Сервисы пакета C выбирают эти функции при manager.isMock
 * (см. client.ts / manager.ts — выбор mock-vs-real).
 */

import { randomUUID } from 'node:crypto';
import type {
  CdekDeliveryMode,
  CdekOffice,
  CdekPackage,
  CdekTariffOption,
  CdekTariffResult,
} from '../types';
import {
  MOCK_CITIES,
  MOCK_OFFICES,
  MOCK_PERIOD_MAX,
  MOCK_PERIOD_MIN,
  MOCK_TARIFF_DOOR,
  MOCK_TARIFF_NAMES,
  MOCK_TARIFF_POSTAMAT,
  MOCK_TARIFF_PVZ,
  mockDeliverySum,
} from './fixtures';
import type { CdekCity } from '../types';

export {
  MOCK_CITIES,
  MOCK_OFFICES,
  MOCK_CITY_MOSCOW,
  MOCK_CITY_SPB,
  mockDeliverySum,
} from './fixtures';

/** URL фейкового PDF для печати (docs/08 §7.3, §11). */
export const MOCK_PRINT_URL = 'https://example.invalid/mock-waybill.pdf';

/** Суммарный вес упаковок (граммы). */
function totalWeight(packages: CdekPackage[]): number {
  return packages.reduce((acc, p) => acc + (p.weight || 0), 0);
}

/** door считается курьерским (надбавка); pvz/postamat — нет. */
function isDoorMode(tariffOrMode: number | CdekDeliveryMode): boolean {
  if (typeof tariffOrMode === 'number') return tariffOrMode === MOCK_TARIFF_DOOR;
  return tariffOrMode === 'door';
}

/**
 * Mock-расчёт по конкретному тарифу (аналог POST /v2/calculator/tariff).
 * Детерминированно: одни входы → один результат.
 */
export function mockCalculateByTariff(
  tariffCode: number,
  packages: CdekPackage[],
): CdekTariffResult {
  const weight = totalWeight(packages);
  return {
    tariffCode,
    deliverySum: mockDeliverySum(weight, isDoorMode(tariffCode)),
    periodMin: MOCK_PERIOD_MIN,
    periodMax: MOCK_PERIOD_MAX,
  };
}

/**
 * Mock-список доступных тарифов (аналог POST /v2/calculator/tarifflist).
 * Возвращает фикстурный набор (ПВЗ/дверь/постамат) с расчётом по весу.
 */
export function mockCalculateAvailable(packages: CdekPackage[]): CdekTariffOption[] {
  const weight = totalWeight(packages);
  const tariffs = [MOCK_TARIFF_PVZ, MOCK_TARIFF_DOOR, MOCK_TARIFF_POSTAMAT];
  return tariffs.map((code, idx) => ({
    tariffCode: code,
    tariffName: MOCK_TARIFF_NAMES[code] ?? null,
    deliverySum: mockDeliverySum(weight, isDoorMode(code)),
    periodMin: MOCK_PERIOD_MIN,
    periodMax: MOCK_PERIOD_MAX,
    deliveryMode: idx,
  }));
}

/** Фильтры списка ПВЗ (аналог GET /v2/deliverypoints). */
export interface MockOfficeFilters {
  cityCode?: number;
  type?: string; // PVZ | POSTAMAT
  code?: string;
}

/**
 * Mock-список ПВЗ из фикстур с фильтрацией по городу/типу/коду (детерминир.).
 * Фикстуры непусты (docs/08 §11: 3–5 ПВЗ).
 */
export function mockGetOffices(filters: MockOfficeFilters = {}): CdekOffice[] {
  const matched = MOCK_OFFICES.filter((o) => {
    if (filters.cityCode !== undefined && o.cityCode !== filters.cityCode) return false;
    if (filters.type && o.type !== filters.type) return false;
    if (filters.code && o.code !== filters.code) return false;
    return true;
  });

  // ДЕМО-fallback: для города без фикстурных ПВЗ (любой кроме Москвы/СПб) отдаём
  // ОДИН синтетический ПВЗ, чтобы чекаут в mock-режиме доходил до конца для любого
  // выбранного города (иначе пустой список ПВЗ = тупик оформления). С боевыми
  // ключами СДЭК отдаёт реальные ПВЗ — этот fallback не задействуется.
  if (matched.length === 0 && filters.cityCode !== undefined && !filters.code) {
    const city = MOCK_CITIES.find((c) => c.code === filters.cityCode);
    const type = filters.type === 'POSTAMAT' ? 'POSTAMAT' : 'PVZ';
    return [
      {
        code: `MOCK-${filters.cityCode}`,
        name: `Пункт выдачи СДЭК (демо) — ${city?.name ?? 'город'}`,
        address: `${city?.name ?? 'Город'}, центральный пункт выдачи (демо-данные)`,
        type,
        cityCode: filters.cityCode,
        location: { latitude: 55.75, longitude: 37.61 },
        workTime: 'Пн-Пт 10:00-20:00, Сб-Вс 11:00-18:00',
      },
    ];
  }

  return matched;
}

/** Поиск ПВЗ по коду (positive/negative). */
export function mockFindOfficeByCode(code: string): CdekOffice | null {
  const found = MOCK_OFFICES.find((o) => o.code === code);
  if (found) return found;
  // Синтетический демо-ПВЗ (MOCK-<cityCode>) из mockGetOffices-fallback — чтобы
  // выбор такого ПВЗ при оформлении не возвращал «не найдено» в mock-режиме.
  const m = /^MOCK-(\d+)$/.exec(code);
  if (m) {
    const cityCode = Number(m[1]);
    const city = MOCK_CITIES.find((c) => c.code === cityCode);
    return {
      code,
      name: `Пункт выдачи СДЭК (демо) — ${city?.name ?? 'город'}`,
      address: `${city?.name ?? 'Город'}, центральный пункт выдачи (демо-данные)`,
      type: 'PVZ',
      cityCode,
      location: { latitude: 55.75, longitude: 37.61 },
      workTime: 'Пн-Пт 10:00-20:00, Сб-Вс 11:00-18:00',
    };
  }
  return null;
}

/**
 * Mock-поиск городов по подстроке имени (аналог GET /v2/location/cities).
 * Регистронезависимо; пустой/короткий запрос → пустой список. Детерминированно.
 */
export function mockSearchCities(query: string): CdekCity[] {
  const q = (query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const matched = MOCK_CITIES.filter((c) => c.name.toLowerCase().includes(q));
  if (matched.length > 0) return matched;

  // ДЕМО-fallback: город вне фикстур → ОДИН синтетический результат, чтобы
  // автокомплит не был пустым (иначе нечего выбрать → нет cityCode → недостижимы
  // ПВЗ/расчёт = тупик оформления в mock-режиме). По аналогии с PVZ-fallback в
  // mockGetOffices. Код детерминирован (стабильный hash) и в высоком диапазоне,
  // чтобы не пересечься с фикстурными кодами; ПВЗ для него отдаёт mockGetOffices
  // (MOCK-<cityCode>). С боевыми/тестовыми ключами СДЭК fallback не задействуется.
  return [{ code: syntheticCityCode(q), name: titleCaseCity(query.trim()), region: 'Демо (СДЭК mock)' }];
}

/** Стабильный положительный код города из нормализованного имени (вне диапазона фикстур). */
function syntheticCityCode(normalized: string): number {
  let h = 0;
  for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) >>> 0;
  return 1_000_000 + (h % 9_000_000);
}

/** Приведение названия города к Title Case (первая буква каждого слова — заглавная). */
function titleCaseCity(s: string): string {
  return s.replace(/(^|[\s-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

/** Результат mock-создания отправления (фейковые uuid/трек, is_mock). */
export interface MockCreateShipmentResult {
  cdekUuid: string;
  cdekNumber: string;
  isMock: true;
}

/**
 * Mock-создание отправления (docs/08 §11):
 *   cdek_uuid = 'mock-' + randomUUID(); cdek_number = '1' + 9 цифр; is_mock=true.
 *
 * Не детерминирован по uuid (намеренно — каждое отправление уникально), но
 * формат стабилен и тестируем (см. tests/cdek/mock/fixtures.test.ts).
 */
export function mockCreateShipment(): MockCreateShipmentResult {
  const tail = Math.floor(100_000_000 + Math.random() * 900_000_000); // 9 цифр
  return {
    cdekUuid: `mock-${randomUUID()}`,
    cdekNumber: `1${tail}`,
    isMock: true,
  };
}

/** Один mock-статус трекинга. */
export interface MockTrackStatus {
  code: string;
  name: string;
  dateTime: string;
}

/**
 * Mock-последовательность статусов отправления (docs/08 §11: Tracking →
 * mock-статусы из фикстур). Детерминированная цепочка happy-path.
 */
export function mockTrackStatuses(): MockTrackStatus[] {
  return [
    { code: 'CREATED', name: 'Создан', dateTime: '2026-06-15T10:00:00+0300' },
    {
      code: 'RECEIVED_AT_SHIPMENT_WAREHOUSE',
      name: 'Принят на склад отправителя',
      dateTime: '2026-06-15T12:00:00+0300',
    },
    { code: 'ON_THE_WAY', name: 'В пути', dateTime: '2026-06-16T08:00:00+0300' },
    {
      code: 'READY_FOR_PICKUP',
      name: 'Готов к выдаче',
      dateTime: '2026-06-17T09:00:00+0300',
    },
    { code: 'DELIVERED', name: 'Вручён', dateTime: '2026-06-18T15:00:00+0300' },
  ];
}

/** Mock-печать: всегда фейковый PDF-URL (docs/08 §7.3, §11). */
export function mockPrintUrl(): string {
  return MOCK_PRINT_URL;
}
