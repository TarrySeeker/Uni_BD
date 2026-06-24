import { describe, expect, it } from 'vitest';

import { resolveLineDims } from '@/lib/orders/repository';

/**
 * ЮНИТ (без БД): резолв веса/габаритов позиции для СДЭК по приоритету
 * вариант→товар (0018/0026). Дефолт магазина здесь НЕ подмешивается — null
 * означает «нет значения в каталоге», его подставит aggregatePackage СДЭК.
 */

type Dims = {
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
};

const productDims = (over: Partial<Dims> = {}): Dims => ({
  weightG: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  ...over,
});

describe('orders/resolveLineDims (приоритет вариант→товар)', () => {
  it('вариант переопределяет товар по каждому полю', () => {
    const product = productDims({ weightG: 1000, lengthCm: 50, widthCm: 40, heightCm: 30 });
    const variant = productDims({ weightG: 250, lengthCm: 20 });
    const r = resolveLineDims(product, variant);
    expect(r.weightG).toBe(250); // вариант
    expect(r.lengthCm).toBe(20); // вариант
    expect(r.widthCm).toBe(40); // от товара (у варианта null)
    expect(r.heightCm).toBe(30); // от товара
  });

  it('нет варианта → берётся товар', () => {
    const product = productDims({ weightG: 800, lengthCm: 12, widthCm: 8, heightCm: 6 });
    const r = resolveLineDims(product, null);
    expect(r).toEqual({ weightG: 800, lengthCm: 12, widthCm: 8, heightCm: 6 });
  });

  it('ни товар, ни вариант не заданы → всё null (дефолт магазина подставит СДЭК)', () => {
    const r = resolveLineDims(productDims(), productDims());
    expect(r).toEqual({ weightG: null, lengthCm: null, widthCm: null, heightCm: null });
  });

  it('вес = 0 на варианте — валиден и переопределяет товар (?? сохраняет 0)', () => {
    const product = productDims({ weightG: 500 });
    const variant = productDims({ weightG: 0 });
    const r = resolveLineDims(product, variant);
    expect(r.weightG).toBe(0);
  });
});
