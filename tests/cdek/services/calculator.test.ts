import { describe, it, expect, vi } from 'vitest';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import {
  Calculator,
  aggregatePackage,
  type CartLineDims,
} from '@/lib/cdek/services/calculator';
import { CDEK_FALLBACK_DIMENSIONS } from '@/lib/cdek/config';
import { CdekError } from '@/lib/cdek/errors';

/**
 * Тесты Calculator (docs/08 §5). Mock-путь — формула детерминирована. Real-путь —
 * замоканный manager.client (без сети): проверяем маппинг ответа СДЭК. Агрегация
 * веса корзины — чистая функция.
 */

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
const realCfg = getCdekConfig({
  NODE_ENV: 'test',
  CDEK_ACCOUNT: 'acc-1',
  CDEK_SECRET: 'sec-1',
  CDEK_BASE_URL: 'https://api.edu.cdek.ru',
});

const defaults = mockCfg.defaultDimensions;

describe('cdek/calculator — aggregatePackage (чистая агрегация корзины)', () => {
  it('суммирует вес × qty, габариты: Д/Ш = max, В = Σ', () => {
    const lines: CartLineDims[] = [
      { qty: 2, weightG: 300, lengthCm: 20, widthCm: 10, heightCm: 5 },
      { qty: 1, weightG: 500, lengthCm: 30, widthCm: 15, heightCm: 8 },
    ];
    const pkg = aggregatePackage(lines, defaults);
    expect(pkg.weight).toBe(300 * 2 + 500); // 1100 г
    expect(pkg.length).toBe(30); // max(20,30)
    expect(pkg.width).toBe(15); // max(10,15)
    expect(pkg.height).toBe(5 * 2 + 8); // 18 = Σ(qty*h)
  });

  it('NULL веса/габаритов позиции → дефолт магазина', () => {
    const lines: CartLineDims[] = [{ qty: 1 }];
    const pkg = aggregatePackage(lines, defaults);
    expect(pkg.weight).toBe(defaults.weightG);
    expect(pkg.length).toBe(defaults.lengthCm);
    expect(pkg.width).toBe(defaults.widthCm);
    expect(pkg.height).toBe(defaults.heightCm);
  });

  it('пустая корзина → одна дефолтная упаковка магазина', () => {
    const pkg = aggregatePackage([], defaults);
    expect(pkg.weight).toBe(defaults.weightG);
    expect(pkg.length).toBe(defaults.lengthCm);
  });

  it('фоллбэк последней инстанции при отсутствии дефолтов магазина', () => {
    const pkg = aggregatePackage([{ qty: 1 }]);
    expect(pkg.weight).toBe(CDEK_FALLBACK_DIMENSIONS.weightG);
  });

  it('вес/высота умножаются на qty; ширина/длина не умножаются (max)', () => {
    const pkg = aggregatePackage(
      [{ qty: 3, weightG: 100, lengthCm: 10, widthCm: 10, heightCm: 4 }],
      defaults,
    );
    expect(pkg.weight).toBe(300);
    expect(pkg.height).toBe(12);
    expect(pkg.length).toBe(10);
    expect(pkg.width).toBe(10);
  });
});

describe('cdek/calculator — mock-путь (детерминированная формула)', () => {
  const m = new CdekManager({ config: mockCfg });
  const calc = new Calculator(m);

  it('calculate возвращает формулу §5.3 (base + perKg*kg)', async () => {
    const res = await calc.calculate({
      to: { code: 137 },
      packages: [{ weight: 500 }],
      tariffCode: 136, // ПВЗ
    });
    // 300 + 100*1 = 400
    expect(res.deliverySum).toBe('400.00');
    expect(res.tariffCode).toBe(136);
    expect(res.periodMin).toBe(2);
    expect(res.periodMax).toBe(5);
  });

  it('курьерский тариф (door) дороже на надбавку', async () => {
    const res = await calc.calculate({
      to: { code: 137 },
      packages: [{ weight: 1500 }],
      tariffCode: 137, // door
    });
    // 300 + 100*2 + 150 = 650
    expect(res.deliverySum).toBe('650.00');
  });

  it('calculate детерминирован: одинаковые входы → одинаковый результат', async () => {
    const a = await calc.calculate({ to: { code: 44 }, packages: [{ weight: 800 }], tariffCode: 136 });
    const b = await calc.calculate({ to: { code: 44 }, packages: [{ weight: 800 }], tariffCode: 136 });
    expect(a).toEqual(b);
  });

  it('calculateAvailable возвращает фикстурный набор тарифов', async () => {
    const list = await calc.calculateAvailable({ to: { code: 137 }, packages: [{ weight: 500 }] });
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((t) => typeof t.tariffCode === 'number')).toBe(true);
  });

  it('собирает packages из позиций корзины', async () => {
    const res = await calc.calculate({
      to: { code: 137 },
      lines: [{ qty: 2, weightG: 500 }], // 1000 г = 1 кг
      tariffCode: 136,
    });
    // 300 + 100*1 = 400
    expect(res.deliverySum).toBe('400.00');
  });
});

describe('cdek/calculator — real-путь (замоканный manager.client)', () => {
  function makeManager(responseBody: unknown) {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok-X'), invalidate: vi.fn(async () => {}) };
    return new CdekManager({ config: realCfg, fetchImpl, tokenCache });
  }

  it('маппинг ответа /v2/calculator/tariff → CdekTariffResult', async () => {
    const m = makeManager({ delivery_sum: 450, period_min: 1, period_max: 3, tariff_code: 136 });
    const calc = new Calculator(m);
    const res = await calc.calculate({ to: { code: 137 }, packages: [{ weight: 500 }], tariffCode: 136 });
    expect(res.deliverySum).toBe('450.00');
    expect(res.periodMin).toBe(1);
    expect(res.periodMax).toBe(3);
    expect(res.tariffCode).toBe(136);
  });

  it('отправляет from_location из конфига (анти-tamper) и packages', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ delivery_sum: 400, period_min: 2, period_max: 5, tariff_code: 136 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 't'), invalidate: vi.fn(async () => {}) };
    const m = new CdekManager({ config: realCfg, fetchImpl, tokenCache });
    const calc = new Calculator(m);
    await calc.calculate({ to: { code: 137 }, packages: [{ weight: 500 }], tariffCode: 136 });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/v2/calculator/tariff');
    const body = JSON.parse(init.body as string);
    expect(body.from_location.code).toBe(realCfg.fromLocationCode);
    expect(body.to_location.code).toBe(137);
    expect(body.tariff_code).toBe(136);
    expect(body.packages[0].weight).toBe(500);
  });

  it('маппинг ответа /v2/calculator/tarifflist → CdekTariffOption[]', async () => {
    const m = makeManager({
      tariff_codes: [
        { tariff_code: 136, tariff_name: 'Склад-склад', delivery_sum: 400, period_min: 2, period_max: 5, delivery_mode: 4 },
        { tariff_code: 137, tariff_name: 'Склад-дверь', delivery_sum: 550, period_min: 2, period_max: 5, delivery_mode: 3 },
      ],
    });
    const calc = new Calculator(m);
    const list = await calc.calculateAvailable({ to: { code: 137 }, packages: [{ weight: 500 }] });
    expect(list).toHaveLength(2);
    expect(list[0].tariffCode).toBe(136);
    expect(list[0].deliverySum).toBe('400.00');
    expect(list[1].tariffName).toBe('Склад-дверь');
  });

  it('пустой/отсутствующий tariff_codes → []', async () => {
    const m = makeManager({});
    const calc = new Calculator(m);
    const list = await calc.calculateAvailable({ to: { code: 137 }, packages: [{ weight: 500 }] });
    expect(list).toEqual([]);
  });
});

/**
 * BUG B (CRITICAL, undercharge): СДЭК на /v2/calculator/tariff может вернуть
 * HTTP 200 БЕЗ цены (delivery_sum/total_sum отсутствуют) — например, когда тариф
 * недоступен для назначения: тело несёт непустой errors[]. Раньше mapTariffResult
 * прогонял отсутствующее поле через toMoney(undefined) === '0.00' и Calculator
 * РЕЗОЛВИЛСЯ с deliverySum '0.00' (resolved-путь), а computeDeliveryCost не видел
 * throw → anti-undercharge guard НЕ срабатывал → заказ с бесплатной доставкой.
 *
 * Фикс: при отсутствии конечной цены ИЛИ непустом errors[] mapTariffResult бросает
 * CdekError('cdek_calc_no_price') — это превращается в DeliveryCalculationError
 * выше по стеку (createOrder → delivery_unavailable; quote softFail → resolved:false).
 * Легитимный нуль (delivery_sum: 0) остаётся валидным '0.00'.
 */
describe('cdek/calculator — real-путь: 200 без цены НЕ резолвится в 0.00 (BUG B)', () => {
  function makeManager(responseBody: unknown) {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok-X'), invalidate: vi.fn(async () => {}) };
    return new CdekManager({ config: realCfg, fetchImpl, tokenCache });
  }

  it('200 c errors[] и без delivery_sum → БРОСАЕТ CdekError (а НЕ 0.00 resolved)', async () => {
    const m = makeManager({
      errors: [{ code: 'v2_calc_tariff_unavailable', message: 'Тариф недоступен' }],
    });
    const calc = new Calculator(m);
    await expect(
      calc.calculate({ to: { code: 137 }, packages: [{ weight: 500 }], tariffCode: 136 }),
    ).rejects.toBeInstanceOf(CdekError);
  });

  it('200 без delivery_sum/total_sum (нет ни цены, ни errors) → БРОСАЕТ CdekError', async () => {
    const m = makeManager({ period_min: 2, period_max: 5, tariff_code: 136 });
    const calc = new Calculator(m);
    await expect(
      calc.calculate({ to: { code: 137 }, packages: [{ weight: 500 }], tariffCode: 136 }),
    ).rejects.toMatchObject({ code: 'cdek_calc_no_price' });
  });

  it('брошенная CdekError несёт structured errors[] СДЭК (для аудита/диагностики)', async () => {
    const m = makeManager({
      errors: [{ code: 'v2_no_tariff', message: 'нет тарифа' }],
    });
    const calc = new Calculator(m);
    let caught: unknown;
    try {
      await calc.calculate({ to: { code: 137 }, packages: [{ weight: 500 }], tariffCode: 136 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CdekError);
    expect((caught as CdekError).cdekErrors).toEqual([
      { code: 'v2_no_tariff', message: 'нет тарифа' },
    ]);
  });

  it('легитимный нуль (delivery_sum: 0, без errors) остаётся валидным 0.00 resolved', async () => {
    const m = makeManager({ delivery_sum: 0, period_min: 1, period_max: 2, tariff_code: 136 });
    const calc = new Calculator(m);
    const res = await calc.calculate({
      to: { code: 137 },
      packages: [{ weight: 500 }],
      tariffCode: 136,
    });
    expect(res.deliverySum).toBe('0.00');
    expect(res.tariffCode).toBe(136);
  });

  it('строковая цена "450.00" по-прежнему маппится корректно', async () => {
    const m = makeManager({ delivery_sum: '450.00', period_min: 1, period_max: 3, tariff_code: 136 });
    const calc = new Calculator(m);
    const res = await calc.calculate({
      to: { code: 137 },
      packages: [{ weight: 500 }],
      tariffCode: 136,
    });
    expect(res.deliverySum).toBe('450.00');
  });
});
