import { describe, it, expect } from 'vitest';

import { destinationLabel, deliveryModeLabel } from '@/lib/cdek/format';

/**
 * Юнит-тесты чистых форматтеров раздела «Доставка (СДЭК)» админки (C17).
 * Без БД/сети — node-харнесс admik. Фиксируют контракт человекочитаемого
 * «Назначения» отправления для списка /admin/cdek (откуда едет/куда едет),
 * чтобы оператор не открывал каждый заказ ради адреса доставки.
 *
 * Мультитенантность: значения берутся из строки БД инстанса; числовой
 * city_code СДЭК намеренно не участвует (нечитаем) — город берётся из
 * orders.delivery_city, заполняемого на чекауте.
 */
describe('cdek/format — destinationLabel', () => {
  it('(a) pvz: город + код ПВЗ из cdek_shipments.pvz_code', () => {
    expect(
      destinationLabel({
        delivery_mode: 'pvz',
        pvz_code: 'MSK123',
        delivery_city: 'Москва',
        delivery_pvz_code: null,
      }),
    ).toBe('Москва, ПВЗ MSK123');
  });

  it('(b) postamat: фолбэк на orders.delivery_pvz_code, без города', () => {
    expect(
      destinationLabel({
        delivery_mode: 'postamat',
        pvz_code: null,
        delivery_pvz_code: 'POST7',
        delivery_city: null,
      }),
    ).toBe('ПВЗ POST7');
  });

  it('(c) door: курьер по городу доставки', () => {
    expect(
      destinationLabel({
        delivery_mode: 'door',
        delivery_city: 'Казань',
        pvz_code: null,
        delivery_pvz_code: null,
      }),
    ).toBe('Казань');
  });

  it('(d) всё пусто → «—»', () => {
    expect(
      destinationLabel({
        delivery_mode: null,
        pvz_code: null,
        delivery_city: null,
        delivery_pvz_code: null,
      }),
    ).toBe('—');
  });
});

describe('cdek/format — deliveryModeLabel', () => {
  it('маппит коды способа доставки в человекочитаемые метки', () => {
    expect(deliveryModeLabel('pvz')).toBe('ПВЗ');
    expect(deliveryModeLabel('postamat')).toBe('Постамат');
    expect(deliveryModeLabel('door')).toBe('Курьер');
    expect(deliveryModeLabel(null)).toBe('—');
    expect(deliveryModeLabel('unknown')).toBe('—');
  });
});
