/**
 * Фикстуры mock-режима СДЭК (docs/08 §11, §5.3, §6).
 *
 * Детерминированные данные, которыми пользуются demo-магазин и тесты без боевых
 * ключей (ADR-002, docs/02). Никакой сети — только статика и чистые формулы.
 */

import type { CdekCity, CdekOffice } from '../types';

/** Коды городов для фикстур (carre/спека: 44 = Москва, 137 = Санкт-Петербург). */
export const MOCK_CITY_MOSCOW = 44;
export const MOCK_CITY_SPB = 137;

/**
 * Фикстурный список городов для автокомплита (mock-режим). Расширен до основных
 * городов РФ, чтобы автокомплит на витрине находил большинство запросов в ДЕМО без
 * боевых ключей. ПОЛНОЕ покрытие всех городов России даёт ТОЛЬКО реальный СДЭК API
 * (боевые/тестовые ключи) — тогда CityService ходит в GET /v2/location/cities.
 * Коды — реальные/правдоподобные коды СДЭК (детерминированно, без сети).
 */
export const MOCK_CITIES: readonly CdekCity[] = [
  { code: MOCK_CITY_MOSCOW, name: 'Москва', region: 'Москва' },
  { code: MOCK_CITY_SPB, name: 'Санкт-Петербург', region: 'Санкт-Петербург' },
  { code: 270, name: 'Новосибирск', region: 'Новосибирская область' },
  { code: 344, name: 'Екатеринбург', region: 'Свердловская область' },
  { code: 430, name: 'Казань', region: 'Республика Татарстан' },
  { code: 414, name: 'Нижний Новгород', region: 'Нижегородская область' },
  { code: 268, name: 'Челябинск', region: 'Челябинская область' },
  { code: 50, name: 'Омск', region: 'Омская область' },
  { code: 426, name: 'Самара', region: 'Самарская область' },
  { code: 438, name: 'Ростов-на-Дону', region: 'Ростовская область' },
  { code: 312, name: 'Уфа', region: 'Республика Башкортостан' },
  { code: 282, name: 'Красноярск', region: 'Красноярский край' },
  { code: 432, name: 'Пермь', region: 'Пермский край' },
  { code: 400, name: 'Воронеж', region: 'Воронежская область' },
  { code: 479, name: 'Волгоград', region: 'Волгоградская область' },
  { code: 435, name: 'Краснодар', region: 'Краснодарский край' },
  { code: 372, name: 'Саратов', region: 'Саратовская область' },
  { code: 56, name: 'Тюмень', region: 'Тюменская область' },
  { code: 277, name: 'Ижевск', region: 'Удмуртская Республика' },
  { code: 297, name: 'Барнаул', region: 'Алтайский край' },
  { code: 142, name: 'Ульяновск', region: 'Ульяновская область' },
  { code: 65, name: 'Иркутск', region: 'Иркутская область' },
  { code: 290, name: 'Хабаровск', region: 'Хабаровский край' },
  { code: 75, name: 'Владивосток', region: 'Приморский край' },
  { code: 197, name: 'Ярославль', region: 'Ярославская область' },
  { code: 78, name: 'Томск', region: 'Томская область' },
  { code: 88, name: 'Оренбург', region: 'Оренбургская область' },
  { code: 1006, name: 'Кемерово', region: 'Кемеровская область' },
  { code: 39, name: 'Рязань', region: 'Рязанская область' },
  { code: 161, name: 'Тула', region: 'Тульская область' },
  { code: 158, name: 'Липецк', region: 'Липецкая область' },
  { code: 273, name: 'Калининград', region: 'Калининградская область' },
  { code: 198, name: 'Сочи', region: 'Краснодарский край' },
] as const;

/**
 * Небольшой фикстур-набор ПВЗ по нескольким городам (Москва/СПб). Координаты —
 * правдоподобные. type: PVZ | POSTAMAT (docs/08 §11: 3–5 ПВЗ для 44/137).
 */
export const MOCK_OFFICES: readonly CdekOffice[] = [
  {
    code: 'MSK1',
    name: 'ПВЗ Москва — Тверская',
    address: 'Москва, ул. Тверская, д. 1',
    type: 'PVZ',
    cityCode: MOCK_CITY_MOSCOW,
    location: { latitude: 55.7558, longitude: 37.6173 },
    workTime: 'Пн-Пт 10:00-20:00, Сб-Вс 11:00-18:00',
  },
  {
    code: 'MSK2',
    name: 'ПВЗ Москва — Арбат',
    address: 'Москва, ул. Арбат, д. 24',
    type: 'PVZ',
    cityCode: MOCK_CITY_MOSCOW,
    location: { latitude: 55.7494, longitude: 37.5936 },
    workTime: 'Пн-Вс 09:00-21:00',
  },
  {
    code: 'MSK-POST1',
    name: 'Постамат Москва — ТЦ Авиапарк',
    address: 'Москва, Ходынский бульвар, д. 4',
    type: 'POSTAMAT',
    cityCode: MOCK_CITY_MOSCOW,
    location: { latitude: 55.7896, longitude: 37.5306 },
    workTime: 'Круглосуточно',
  },
  {
    code: 'SPB1',
    name: 'ПВЗ Санкт-Петербург — Невский',
    address: 'Санкт-Петербург, Невский пр-т, д. 28',
    type: 'PVZ',
    cityCode: MOCK_CITY_SPB,
    location: { latitude: 59.9357, longitude: 30.3258 },
    workTime: 'Пн-Пт 10:00-20:00, Сб 11:00-17:00',
  },
  {
    code: 'SPB-POST1',
    name: 'Постамат Санкт-Петербург — ТЦ Галерея',
    address: 'Санкт-Петербург, Лиговский пр-т, д. 30А',
    type: 'POSTAMAT',
    cityCode: MOCK_CITY_SPB,
    location: { latitude: 59.9276, longitude: 30.3608 },
    workTime: 'Круглосуточно',
  },
] as const;

/** Коды тарифов mock-режима (склад-ПВЗ 136, склад-дверь 137, постамат 368). */
export const MOCK_TARIFF_PVZ = 136;
export const MOCK_TARIFF_DOOR = 137;
export const MOCK_TARIFF_POSTAMAT = 368;

/** Имена тарифов для фикстурного списка тарифов. */
export const MOCK_TARIFF_NAMES: Record<number, string> = {
  [MOCK_TARIFF_PVZ]: 'Посылка склад-склад',
  [MOCK_TARIFF_DOOR]: 'Посылка склад-дверь',
  [MOCK_TARIFF_POSTAMAT]: 'Посылка склад-постамат',
};

// ---------------------------------------------------------------------------
// Формула расчёта тарифа (docs/08 §5.3). Детерминированная, без сети.
// ---------------------------------------------------------------------------

/** Базовая ставка, ₽ (docs/08 §5.3). */
export const MOCK_TARIFF_BASE_RUB = 300;
/** Ставка за килограмм, ₽/кг. */
export const MOCK_TARIFF_PER_KG_RUB = 100;
/** Надбавка за курьер (door) против ПВЗ, ₽. */
export const MOCK_TARIFF_COURIER_SURCHARGE_RUB = 150;
/** Сроки доставки (детерминированные). */
export const MOCK_PERIOD_MIN = 2;
export const MOCK_PERIOD_MAX = 5;

/**
 * Mock-стоимость доставки по формуле §5.3:
 *   base + perKg * ceil(weightG/1000) + (door ? courierSurcharge : 0).
 *
 * Возвращает строку NUMERIC(14,2) (как деньги в orders). Детерминированно.
 */
export function mockDeliverySum(weightG: number, isDoor: boolean): string {
  const weightKg = Math.max(1, Math.ceil(weightG / 1000));
  const sum =
    MOCK_TARIFF_BASE_RUB +
    MOCK_TARIFF_PER_KG_RUB * weightKg +
    (isDoor ? MOCK_TARIFF_COURIER_SURCHARGE_RUB : 0);
  return sum.toFixed(2);
}
