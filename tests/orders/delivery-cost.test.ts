import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Юнит-тесты адаптера расчёта стоимости доставки (docs/08 §5, пакет E).
 *
 * Адаптер lib/orders/delivery-cost разводит orders↔cdek: чистый выбор провайдера
 * (stub vs cdek) + расчёт. Сети/БД нет — cdek-провайдер работает в mock-режиме
 * (isCdekMock при пустых CDEK_*). Проверяем:
 *   • модуль cdek выключен → провайдер 0 (stub), поведение Этапа 3 сохранено;
 *   • pickup → 0 даже при включённом cdek;
 *   • cdek включён + назначение → mock-расчёт (детерминирован, source cdek_mock);
 *   • выбор провайдера (pickStubProvider/needsCdek — чистая часть).
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_ACCOUNT = process.env.CDEK_ACCOUNT;
const ORIGINAL_SECRET = process.env.CDEK_SECRET;

async function load() {
  vi.resetModules();
  return import('@/lib/orders/delivery-cost');
}

describe('orders/delivery-cost — адаптер расчёта доставки', () => {
  beforeEach(() => {
    // mock-режим СДЭК: боевых ключей нет (расчёт по формуле, без сети).
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    if (ORIGINAL_ACCOUNT === undefined) delete process.env.CDEK_ACCOUNT;
    else process.env.CDEK_ACCOUNT = ORIGINAL_ACCOUNT;
    if (ORIGINAL_SECRET === undefined) delete process.env.CDEK_SECRET;
    else process.env.CDEK_SECRET = ORIGINAL_SECRET;
    vi.resetModules();
  });

  it('pickup → 0.00 (source stub) даже при включённом cdek', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'pickup',
      lines: [{ qty: 1 }],
      destination: { cityCode: 44 },
    });
    expect(res.cost).toBe('0.00');
    expect(res.source).toBe('stub');
  });

  it('модуль cdek выключен → провайдер 0 (stub), как Этап 3', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: { cityCode: 44 },
    });
    expect(res.cost).toBe('0.00');
    expect(res.source).toBe('stub');
    expect(res.tariffCode).toBeNull();
  });

  it('cdek выключен и без destination → 0.00 stub', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'pvz',
      lines: [{ qty: 2 }],
      destination: {},
    });
    expect(res.cost).toBe('0.00');
    expect(res.source).toBe('stub');
  });

  it('cdek включён + назначение → mock-расчёт (детерминирован, > 0)', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const a = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityCode: 44 },
    });
    const b = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityCode: 44 },
    });
    expect(a.source).toBe('cdek_mock');
    expect(Number(a.cost)).toBeGreaterThan(0);
    expect(a.cost).toBe(b.cost); // детерминизм mock-формулы
    expect(a.periodMin).toBeGreaterThan(0);
  });

  it('cdek включён, но без назначения → 0.00 stub (нечего считать)', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: {},
    });
    expect(res.cost).toBe('0.00');
    expect(res.source).toBe('stub');
  });

  // BUG #3 (correctness): курьерская доставка из orders несёт назначение ТОЛЬКО
  // строковым cityName (deliverySelectionSchema.city → destination.cityName). До
  // фикса hasDestination игнорировал cityName → needsCdekProvider=false → stub
  // 0.00, поэтому курьерская доставка всегда считалась бесплатной. Назначение по
  // имени города ДОЛЖНО триггерить cdek-расчёт (mock считает по весу).
  it('cdek включён + только cityName (курьер) → mock-расчёт, не 0.00 (BUG #3)', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityName: 'Москва' },
    });
    expect(res.source).toBe('cdek_mock');
    expect(Number(res.cost)).toBeGreaterThan(0);
  });

  it('hasDestination учитывает cityName: needsCdekProvider true при наличии города', async () => {
    process.env.ADMIK_MODULES = 'orders,cdek';
    const { computeDeliveryCost } = await load();
    // pvz без pvzCode, но с cityName — расчёт должен пройти (назначение есть).
    const res = await computeDeliveryCost({
      deliveryType: 'pvz',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityName: 'Санкт-Петербург' },
    });
    expect(res.source).toBe('cdek_mock');
    expect(Number(res.cost)).toBeGreaterThan(0);
  });

  it('needsCdekProvider — чистый выбор провайдера', async () => {
    const { needsCdekProvider } = await load();
    // pickup никогда не считаем
    expect(
      needsCdekProvider({ cdekEnabled: true, deliveryType: 'pickup', hasDestination: true }),
    ).toBe(false);
    // cdek выключен
    expect(
      needsCdekProvider({ cdekEnabled: false, deliveryType: 'courier', hasDestination: true }),
    ).toBe(false);
    // нет назначения
    expect(
      needsCdekProvider({ cdekEnabled: true, deliveryType: 'courier', hasDestination: false }),
    ).toBe(false);
    // всё на месте → cdek
    expect(
      needsCdekProvider({ cdekEnabled: true, deliveryType: 'courier', hasDestination: true }),
    ).toBe(true);
    expect(
      needsCdekProvider({ cdekEnabled: true, deliveryType: 'pvz', hasDestination: true }),
    ).toBe(true);
  });
});

/**
 * BUG (major, data-integrity — undercharge): при РЕАЛЬНО НУЖНОМ расчёте СДЭК
 * (useCdek=true) сбой расчёта (сеть/ошибка СДЭК) молча превращался в 0.00 — и в
 * quote, и при СОЗДАНИИ ЗАКАЗА. Клиент недоплачивал за доставку.
 *
 * Эти тесты мокают lazy-import @/lib/cdek/services/calculator + @/lib/cdek/manager,
 * чтобы calculate БРОСАЛ. Проверяем:
 *   • createOrder-путь (softFail НЕ задан) → НЕ возвращает 0 молча, а БРОСАЕТ
 *     доменную DeliveryCalculationError (блокирует создание заказа);
 *   • quote-путь (softFail:true) → НЕ бросает, но сигналит нерасчитанность
 *     (resolved:false, source:'unavailable') — витрина покажет «уточняется»;
 *   • by-design 0.00 (pickup/disabled/no destination) остаётся 0.00 и resolved:true;
 *   • успешный расчёт → корректная сумма, resolved:true.
 */
describe('orders/delivery-cost — сбой расчёта СДЭК НЕ обнуляет доставку (undercharge)', () => {
  const ORIG_MODULES = process.env.ADMIK_MODULES;

  /** Загрузка модуля с замоканным cdek: calculate бросает или возвращает зад. сумму. */
  async function loadWithCdek(opts: {
    calculate: () => Promise<unknown> | never;
    isMock?: boolean;
  }) {
    vi.resetModules();
    vi.doMock('@/lib/cdek/services/calculator', () => ({
      Calculator: class {
        constructor(_m: unknown) {}
        async calculate() {
          return opts.calculate();
        }
      },
    }));
    vi.doMock('@/lib/cdek/manager', () => ({
      getCdekManager: () => ({ isMock: opts.isMock ?? true }),
    }));
    return import('@/lib/orders/delivery-cost');
  }

  beforeEach(() => {
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
    process.env.ADMIK_MODULES = 'orders,cdek';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIG_MODULES;
    vi.resetModules();
    vi.doUnmock('@/lib/cdek/services/calculator');
    vi.doUnmock('@/lib/cdek/manager');
  });

  it('createOrder-путь: сбой расчёта при useCdek → БРОСАЕТ (а НЕ молча 0.00)', async () => {
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () => {
        throw new Error('network down (CDEK)');
      },
    });
    await expect(
      computeDeliveryCost({
        deliveryType: 'courier',
        lines: [{ qty: 1, weightG: 500 }],
        destination: { cityName: 'Москва' },
      }),
    ).rejects.toMatchObject({ code: 'delivery_calc_failed' });
  });

  it('createOrder-путь: брошенная ошибка несёт человекочитаемое сообщение для UI', async () => {
    const { computeDeliveryCost, DeliveryCalculationError } = await loadWithCdek({
      calculate: () => Promise.reject(new Error('CDEK 500')),
    });
    let caught: unknown;
    try {
      await computeDeliveryCost({
        deliveryType: 'courier',
        lines: [{ qty: 1 }],
        destination: { cityCode: 44 },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeliveryCalculationError);
    expect((caught as Error).message).toMatch(/доставк/i);
  });

  it('quote-путь (softFail): сбой расчёта → НЕ бросает, сигналит нерасчитанность', async () => {
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () => {
        throw new Error('boom');
      },
    });
    const res = await computeDeliveryCost(
      {
        deliveryType: 'courier',
        lines: [{ qty: 1 }],
        destination: { cityName: 'Москва' },
      },
      { softFail: true },
    );
    expect(res.resolved).toBe(false);
    expect(res.source).toBe('unavailable');
  });

  it('успешный расчёт → корректная сумма, resolved:true', async () => {
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: async () => ({
        deliverySum: '349.00',
        periodMin: 2,
        periodMax: 4,
        tariffCode: 136,
      }),
    });
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityName: 'Москва' },
    });
    expect(res.cost).toBe('349.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('cdek_mock');
    expect(res.tariffCode).toBe(136);
  });

  it('by-design 0.00 не маскирует сбой: pickup → resolved:true даже с бросающим cdek', async () => {
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () => {
        throw new Error('should not be called for pickup');
      },
    });
    const res = await computeDeliveryCost({
      deliveryType: 'pickup',
      lines: [{ qty: 1 }],
      destination: { cityCode: 44 },
    });
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('stub');
  });

  it('by-design 0.00: модуль cdek выключен → resolved:true, расчёт не зовётся', async () => {
    process.env.ADMIK_MODULES = 'orders';
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () => {
        throw new Error('should not be called when cdek disabled');
      },
    });
    const res = await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1 }],
      destination: { cityName: 'Москва' },
    });
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('stub');
  });

  it('softFail НЕ влияет на by-design stub: pickup всё равно 0.00 resolved:true', async () => {
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () => {
        throw new Error('nope');
      },
    });
    const res = await computeDeliveryCost(
      { deliveryType: 'pickup', lines: [{ qty: 1 }], destination: {} },
      { softFail: true },
    );
    expect(res.cost).toBe('0.00');
    expect(res.resolved).toBe(true);
    expect(res.source).toBe('stub');
  });

  // BUG B (CRITICAL, undercharge): СДЭК-калькулятор отвечает 200 БЕЗ цены
  // (errors[] вместо delivery_sum) → Calculator.calculate теперь бросает CdekError
  // (а не резолвится в 0.00). Здесь проверяем КОМПОЗИЦИЮ: брошенный CdekError
  // обрабатывается computeDeliveryCost так же, как сетевой сбой — createOrder-путь
  // БРОСАЕТ DeliveryCalculationError, quote softFail → resolved:false. То есть
  // заказ с «бесплатной» доставкой из-за недоступного тарифа более невозможен.
  it('CdekError «нет цены» (200+errors) → createOrder-путь БРОСАЕТ (не 0.00)', async () => {
    const { CdekError } = await import('@/lib/cdek/errors');
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () =>
        Promise.reject(
          new CdekError('cdek_calc_no_price', 'СДЭК калькулятор не вернул цену доставки.', {
            cdekErrors: [{ code: 'v2_calc_tariff_unavailable', message: 'Тариф недоступен' }],
          }),
        ),
    });
    await expect(
      computeDeliveryCost({
        deliveryType: 'courier',
        lines: [{ qty: 1, weightG: 500 }],
        destination: { cityName: 'Москва' },
      }),
    ).rejects.toMatchObject({ code: 'delivery_calc_failed' });
  });

  it('CdekError «нет цены» (200+errors) → quote softFail → resolved:false', async () => {
    const { CdekError } = await import('@/lib/cdek/errors');
    const { computeDeliveryCost } = await loadWithCdek({
      calculate: () =>
        Promise.reject(new CdekError('cdek_calc_no_price', 'нет цены', { cdekErrors: [] })),
    });
    const res = await computeDeliveryCost(
      {
        deliveryType: 'courier',
        lines: [{ qty: 1, weightG: 500 }],
        destination: { cityName: 'Москва' },
      },
      { softFail: true },
    );
    expect(res.resolved).toBe(false);
    expect(res.source).toBe('unavailable');
  });
});

/**
 * M4 (полнота, цикл 3): авторитетная стоимость доставки (computeDeliveryCost, anti-
 * tamper при создании заказа) выбирает тариф ПО РЕЖИМУ, когда явный tariffCode не
 * передан. Раньше курьер тарифицировался ПВЗ-тарифом 136 (Calculator падал на
 * defaultTariffCode) → клиент недоплачивал за курьерскую доставку, накладная же шла
 * по 137. Здесь — capture tariffCode, уходящего в Calculator.calculate.
 */
describe('orders/delivery-cost — тариф по режиму (курьер≠ПВЗ-тариф)', () => {
  const ORIG = process.env.ADMIK_MODULES;

  async function loadCapturing(captured: { tariffCode?: number }) {
    vi.resetModules();
    vi.doMock('@/lib/cdek/services/calculator', () => ({
      Calculator: class {
        constructor(_m: unknown) {}
        async calculate(input: { tariffCode?: number }) {
          captured.tariffCode = input.tariffCode;
          return { deliverySum: '500.00', tariffCode: input.tariffCode, periodMin: 2, periodMax: 5 };
        }
      },
    }));
    vi.doMock('@/lib/cdek/manager', () => ({ getCdekManager: () => ({ isMock: true }) }));
    return import('@/lib/orders/delivery-cost');
  }

  beforeEach(() => {
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
    delete process.env.CDEK_DEFAULT_TARIFF;
    delete process.env.CDEK_DOOR_TARIFF;
    process.env.ADMIK_MODULES = 'orders,cdek';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIG;
    vi.resetModules();
    vi.doUnmock('@/lib/cdek/services/calculator');
    vi.doUnmock('@/lib/cdek/manager');
  });

  it('курьер без явного tariffCode → тариф склад-дверь 137 (НЕ ПВЗ-136)', async () => {
    const captured: { tariffCode?: number } = {};
    const { computeDeliveryCost } = await loadCapturing(captured);
    await computeDeliveryCost({
      deliveryType: 'courier',
      lines: [{ qty: 1, weightG: 500 }],
      destination: { cityName: 'Москва', cityCode: 44 },
    });
    expect(captured.tariffCode).toBe(137);
  });

  it('ПВЗ без явного tariffCode → тариф 136', async () => {
    const captured: { tariffCode?: number } = {};
    const { computeDeliveryCost } = await loadCapturing(captured);
    await computeDeliveryCost({
      deliveryType: 'pvz',
      lines: [{ qty: 1 }],
      destination: { cityCode: 44, pvzCode: 'MSK1' },
    });
    expect(captured.tariffCode).toBe(136);
  });

  it('явный tariffCode имеет приоритет над режимом', async () => {
    const captured: { tariffCode?: number } = {};
    const { computeDeliveryCost } = await loadCapturing(captured);
    await computeDeliveryCost({
      deliveryType: 'courier',
      tariffCode: 482,
      lines: [{ qty: 1 }],
      destination: { cityCode: 44 },
    });
    expect(captured.tariffCode).toBe(482);
  });
});
