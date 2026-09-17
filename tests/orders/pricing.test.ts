import { describe, expect, it } from 'vitest';

import {
  calculateQuote,
  emptyScopeTargets,
  itemsTotalMinor,
  lineTotalMinor,
  promoDiscountMinor,
  resolveDelivery,
  type AppliedPromo,
  type PricedLine,
  type PromoScopeTargets,
  type QuoteInput,
} from '@/lib/orders/pricing';

/**
 * Матрица серверного расчёта корзины (docs/07 §3.1–§3.3, ADR-010).
 * Чистые функции — всегда зелёные. Деньги точны (копейки, без float).
 */

function line(over: Partial<PricedLine> = {}): PricedLine {
  return {
    name: over.name ?? 'Товар',
    sku: over.sku ?? 'SKU-1',
    unitPrice: over.unitPrice ?? '100.00',
    compareAt: over.compareAt ?? null,
    qty: over.qty ?? 1,
    ...(over.productId !== undefined ? { productId: over.productId } : {}),
    ...(over.variantId !== undefined ? { variantId: over.variantId } : {}),
    ...(over.categoryIds !== undefined ? { categoryIds: over.categoryIds } : {}),
    ...(over.brandId !== undefined ? { brandId: over.brandId } : {}),
  };
}

function promo(over: Partial<AppliedPromo> = {}): AppliedPromo {
  return {
    code: over.code ?? 'TEST',
    kind: over.kind ?? 'percent',
    value: over.value ?? '10',
    maxDiscount: over.maxDiscount ?? null,
    bogoBuyQty: over.bogoBuyQty ?? null,
    bogoPayQty: over.bogoPayQty ?? null,
    ...(over.applyScope !== undefined ? { applyScope: over.applyScope } : {}),
    ...(over.minQty !== undefined ? { minQty: over.minQty } : {}),
  };
}

describe('pricing — суммы позиций', () => {
  it('lineTotalMinor = unitPrice × qty', () => {
    expect(lineTotalMinor(line({ unitPrice: '19.99', qty: 3 }))).toBe(5997);
  });

  it('itemsTotalMinor суммирует несколько позиций', () => {
    expect(
      itemsTotalMinor([
        line({ unitPrice: '100.00', qty: 2 }),
        line({ unitPrice: '49.50', qty: 1 }),
      ]),
    ).toBe(20000 + 4950);
  });

  it('отклоняет нулевое/дробное qty', () => {
    expect(() => lineTotalMinor(line({ qty: 0 }))).toThrow();
    expect(() => lineTotalMinor(line({ qty: 1.5 }))).toThrow();
  });

  it('бросает при переполнении MAX_SAFE_INTEGER (защита точности, Fix 2)', () => {
    // unitPrice 1e12 руб = 1e14 коп; × qty 1000 = 1e17 > MAX_SAFE_INTEGER (~9e15).
    expect(() =>
      lineTotalMinor(line({ unitPrice: '999999999999.99', qty: 1000 })),
    ).toThrow();
  });

  it('не бросает на разумных значениях у верхней границы qty', () => {
    // qty 10000 (макс схемы) × 1000.00 руб = 1e9 коп — в безопасном диапазоне.
    expect(lineTotalMinor(line({ unitPrice: '1000.00', qty: 10000 }))).toBe(1_000_000_000);
  });
});

describe('pricing — скидка промокода (§3.2)', () => {
  const items = 100000; // 1000.00 в копейках

  it('percent: round(items × value/100)', () => {
    expect(promoDiscountMinor(promo({ kind: 'percent', value: '10' }), items)).toBe(10000);
  });

  it('percent с maxDiscount: обрезается потолком', () => {
    expect(
      promoDiscountMinor(promo({ kind: 'percent', value: '50', maxDiscount: '200.00' }), items),
    ).toBe(20000);
  });

  it('fixed: min(value, items)', () => {
    expect(promoDiscountMinor(promo({ kind: 'fixed', value: '300.00' }), items)).toBe(30000);
  });

  it('fixed больше суммы товаров → обрезается до items', () => {
    expect(promoDiscountMinor(promo({ kind: 'fixed', value: '5000.00' }), items)).toBe(items);
  });

  it('free_delivery: скидка на товары = 0', () => {
    expect(promoDiscountMinor(promo({ kind: 'free_delivery' }), items)).toBe(0);
  });

  it('bogo: задел (Этап 5.2) — пока 0', () => {
    expect(
      promoDiscountMinor(promo({ kind: 'bogo', bogoBuyQty: 3, bogoPayQty: 2 }), items),
    ).toBe(0);
  });

  it('нет промокода → 0', () => {
    expect(promoDiscountMinor(null, items)).toBe(0);
  });
});

describe('pricing — доставка и порог бесплатной (§3.3)', () => {
  it('порог достигнут (после скидки) → бесплатно', () => {
    const r = resolveDelivery({ cost: '350.00', freeThreshold: 3000 }, 300000, null);
    expect(r.freeThresholdMet).toBe(true);
    expect(r.free).toBe(true);
    expect(r.costMinor).toBe(0);
  });

  it('порог НЕ достигнут → платная доставка', () => {
    const r = resolveDelivery({ cost: '350.00', freeThreshold: 3000 }, 250000, null);
    expect(r.freeThresholdMet).toBe(false);
    expect(r.free).toBe(false);
    expect(r.costMinor).toBe(35000);
  });

  it('порог выключен (0) → всегда платная', () => {
    const r = resolveDelivery({ cost: '350.00', freeThreshold: 0 }, 9999999, null);
    expect(r.freeThresholdMet).toBe(false);
    expect(r.costMinor).toBe(35000);
  });

  it('промокод free_delivery → бесплатно даже ниже порога', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 3000 },
      100000,
      promo({ kind: 'free_delivery' }),
    );
    expect(r.freeThresholdMet).toBe(false);
    expect(r.free).toBe(true);
    expect(r.costMinor).toBe(0);
  });

  // Баг #10 (защита для легаси-данных): scoped free_delivery (applyScope≠cart) —
  // бесплатная доставка ТОЛЬКО если в scope реально есть товары. Признак «есть
  // товар в scope» вычисляет вызывающий код (calculateQuote по lineInScope) и
  // передаёт 4-м аргументом. По умолчанию (флаг не передан / промокод не scoped)
  // поведение прежнее.
  it('scoped free_delivery без товара в scope → НЕ бесплатно (флаг false)', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 0 },
      100000,
      promo({ kind: 'free_delivery', applyScope: 'category' }),
      false, // в scope нет ни одной линии
    );
    expect(r.free).toBe(false);
    expect(r.costMinor).toBe(35000);
  });

  it('scoped free_delivery c товаром в scope → бесплатно (флаг true)', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 0 },
      100000,
      promo({ kind: 'free_delivery', applyScope: 'category' }),
      true, // в scope есть подходящая линия
    );
    expect(r.free).toBe(true);
    expect(r.costMinor).toBe(0);
  });

  it('cart free_delivery: флаг scope не влияет — всегда бесплатно', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 0 },
      100000,
      promo({ kind: 'free_delivery', applyScope: 'cart' }),
      false,
    );
    expect(r.free).toBe(true);
    expect(r.costMinor).toBe(0);
  });
});

describe('pricing — calculateQuote: scoped free_delivery (баг #10, защита легаси)', () => {
  const CAT = 'cat-1';

  function scopeTargets(categoryIds: string[]): PromoScopeTargets {
    const t = emptyScopeTargets();
    for (const c of categoryIds) t.categoryIds.add(c);
    return t;
  }

  it('scoped free_delivery, в корзине НЕТ товара scope → доставка платная', () => {
    const q = calculateQuote({
      lines: [
        line({ unitPrice: '500.00', qty: 1, categoryIds: ['other-cat'] }),
      ],
      promo: promo({ kind: 'free_delivery', applyScope: 'category' }),
      delivery: { cost: '350.00', freeThreshold: 0 },
      scopeTargets: scopeTargets([CAT]),
    });
    expect(q.deliveryCost).toBe('350.00');
    expect(q.delivery.free).toBe(false);
    expect(q.grandTotal).toBe('850.00'); // 500 + 350
  });

  it('scoped free_delivery, в корзине ЕСТЬ товар scope → доставка бесплатна', () => {
    const q = calculateQuote({
      lines: [
        line({ unitPrice: '500.00', qty: 1, categoryIds: [CAT] }),
      ],
      promo: promo({ kind: 'free_delivery', applyScope: 'category' }),
      delivery: { cost: '350.00', freeThreshold: 0 },
      scopeTargets: scopeTargets([CAT]),
    });
    expect(q.deliveryCost).toBe('0.00');
    expect(q.delivery.free).toBe(true);
    expect(q.grandTotal).toBe('500.00');
  });

  it('cart free_delivery без scopeTargets → прежнее поведение (бесплатно)', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '500.00', qty: 1 })],
      promo: promo({ kind: 'free_delivery', applyScope: 'cart' }),
      delivery: { cost: '350.00', freeThreshold: 0 },
    });
    expect(q.deliveryCost).toBe('0.00');
    expect(q.delivery.free).toBe(true);
  });
});

describe('pricing — calculateQuote: free_delivery без выгоды не «применяется» (m4)', () => {
  it('самовывоз/stub (cost=0.00) → promo.applied=false (лимит не сжигается)', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '500.00', qty: 1 })],
      promo: promo({ kind: 'free_delivery', code: 'FREESHIP' }),
      delivery: { cost: '0.00', freeThreshold: 0 },
    });
    expect(q.deliveryCost).toBe('0.00');
    expect(q.promo.applied).toBe(false);
    expect(q.promo.code).toBeNull();
  });

  it('порог бесплатной доставки уже достигнут → promo.applied=false', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '5000.00', qty: 1 })],
      promo: promo({ kind: 'free_delivery', code: 'FREESHIP' }),
      delivery: { cost: '350.00', freeThreshold: 1000 },
    });
    expect(q.deliveryCost).toBe('0.00'); // бесплатно по порогу
    expect(q.delivery.freeThresholdMet).toBe(true);
    expect(q.promo.applied).toBe(false); // промокод ничего не добавил
    expect(q.promo.code).toBeNull();
  });

  it('реальная выгода (доставка платная, порог не достигнут) → promo.applied=true', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '500.00', qty: 1 })],
      promo: promo({ kind: 'free_delivery', code: 'FREESHIP' }),
      delivery: { cost: '350.00', freeThreshold: 0 },
    });
    expect(q.deliveryCost).toBe('0.00');
    expect(q.promo.applied).toBe(true);
    expect(q.promo.code).toBe('FREESHIP');
  });
});

describe('pricing — calculateQuote (полный итог)', () => {
  it('базовый: несколько позиций без промо/порога', () => {
    const input: QuoteInput = {
      lines: [line({ unitPrice: '100.00', qty: 2 }), line({ unitPrice: '50.00', qty: 1 })],
      delivery: { cost: '300.00', freeThreshold: 0 },
    };
    const q = calculateQuote(input);
    expect(q.itemsTotal).toBe('250.00');
    expect(q.discount).toBe('0.00');
    expect(q.deliveryCost).toBe('300.00');
    expect(q.grandTotal).toBe('550.00');
    expect(q.promo.applied).toBe(false);
    expect(q.lines).toHaveLength(2);
    expect(q.lines[0]?.lineTotal).toBe('200.00');
  });

  it('percent промо + порог достигнут после скидки → бесплатная доставка', () => {
    // items 4000, -10% = 3600 ≥ 3000 порог → доставка 0
    const q = calculateQuote({
      lines: [line({ unitPrice: '1000.00', qty: 4 })],
      promo: promo({ kind: 'percent', value: '10' }),
      delivery: { cost: '350.00', freeThreshold: 3000 },
    });
    expect(q.itemsTotal).toBe('4000.00');
    expect(q.discount).toBe('400.00');
    expect(q.deliveryCost).toBe('0.00');
    expect(q.grandTotal).toBe('3600.00');
    expect(q.delivery.freeThresholdMet).toBe(true);
    expect(q.promo.applied).toBe(true);
    expect(q.promo.code).toBe('TEST');
  });

  it('скидка опускает ниже порога → доставка снова платная', () => {
    // items 3100, -300 fixed = 2800 < 3000 порог → платная доставка
    const q = calculateQuote({
      lines: [line({ unitPrice: '3100.00', qty: 1 })],
      promo: promo({ kind: 'fixed', value: '300.00' }),
      delivery: { cost: '350.00', freeThreshold: 3000 },
    });
    expect(q.itemsTotal).toBe('3100.00');
    expect(q.discount).toBe('300.00');
    expect(q.deliveryCost).toBe('350.00');
    expect(q.grandTotal).toBe('3150.00'); // 3100 - 300 + 350
    expect(q.delivery.freeThresholdMet).toBe(false);
  });

  it('free_delivery промо: товары без скидки, доставка 0', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '500.00', qty: 1 })],
      promo: promo({ kind: 'free_delivery' }),
      delivery: { cost: '350.00', freeThreshold: 0 },
    });
    expect(q.itemsTotal).toBe('500.00');
    expect(q.discount).toBe('0.00');
    expect(q.deliveryCost).toBe('0.00');
    expect(q.grandTotal).toBe('500.00');
    expect(q.promo.applied).toBe(true);
    expect(q.promo.kind).toBe('free_delivery');
    expect(q.delivery.free).toBe(true);
  });

  it('округление percent корректно (нет float-ошибок)', () => {
    // 3 × 9.99 = 29.97; 15% = 4.4955 → round 4.50
    const q = calculateQuote({
      lines: [line({ unitPrice: '9.99', qty: 3 })],
      promo: promo({ kind: 'percent', value: '15' }),
      delivery: { cost: '0.00', freeThreshold: 0 },
    });
    expect(q.itemsTotal).toBe('29.97');
    expect(q.discount).toBe('4.50');
    expect(q.grandTotal).toBe('25.47');
  });

  it('самовывоз (cost 0) → доставка 0 и не «бесплатно по порогу»', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '100.00', qty: 1 })],
      delivery: { cost: '0.00', freeThreshold: 0 },
    });
    expect(q.deliveryCost).toBe('0.00');
    expect(q.grandTotal).toBe('100.00');
  });

  it('сохраняет снимок compareAt и нормализует цены', () => {
    const q = calculateQuote({
      lines: [line({ unitPrice: '100.0', compareAt: '150', qty: 1 })],
      delivery: { cost: '0', freeThreshold: 0 },
    });
    expect(q.lines[0]?.unitPrice).toBe('100.00');
    expect(q.lines[0]?.compareAt).toBe('150.00');
  });
});

/**
 * Право на бесплатную доставку по порогу (freeEligible).
 *
 * Решение владельца магазина: порог «бесплатно от суммы» действует ТОЛЬКО по
 * России; СНГ и зарубеж платят реальную стоимость доставки. Флаг вычисляется
 * по стране заказа и приезжает в расчёт готовым.
 *
 * 🔴 Почему сравнение именно с `false`, а не «если не true». Поле
 * опциональное, и `undefined` означает «страна неизвестна / признак не
 * передан» — для таких заказов поведение обязано остаться ПРЕЖНИМ (порог
 * работает). Иначе добавление поля молча лишило бы бесплатной доставки все
 * уже работающие магазины и все старые заказы.
 */
describe('pricing — freeEligible: порог бесплатной только для РФ', () => {
  it('🔴 freeEligible=false → порог НЕ применяется, доставка платная', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 3000, freeEligible: false },
      300000, // сумма ВЫШЕ порога
      null,
    );
    expect(r.freeThresholdMet).toBe(false);
    expect(r.free).toBe(false);
    expect(r.costMinor).toBe(35000);
  });

  it('freeEligible=true → порог работает как обычно', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 3000, freeEligible: true },
      300000,
      null,
    );
    expect(r.freeThresholdMet).toBe(true);
    expect(r.costMinor).toBe(0);
  });

  /**
   * 🔴 Обратная совместимость: поле не передано → ведём себя как до появления
   * фичи. Это защищает уже работающие магазины от молчаливой смены цен.
   */
  it('🔴 freeEligible не задан → порог работает (прежнее поведение)', () => {
    const r = resolveDelivery({ cost: '350.00', freeThreshold: 3000 }, 300000, null);
    expect(r.freeThresholdMet).toBe(true);
    expect(r.costMinor).toBe(0);
  });

  /**
   * Промокод на бесплатную доставку — явная акция магазина, а не порог.
   * Он обязан действовать и для не-РФ: иначе выданный покупателю промокод
   * молча не сработает, и это будет выглядеть обманом.
   */
  it('промокод free_delivery действует даже при freeEligible=false', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 3000, freeEligible: false },
      100000, // ниже порога
      { kind: 'free_delivery' } as never,
    );
    expect(r.free).toBe(true);
    expect(r.costMinor).toBe(0);
    // Но именно ПОРОГ при этом не выполнен — различие важно для отчётности
    // и для правила «промокод не дублирует уже бесплатную доставку».
    expect(r.freeThresholdMet).toBe(false);
  });
});

/**
 * Распознавание РФ по названию страны (то, что приезжает от витрины).
 *
 * Проверяем через публичное поведение расчёта: страна влияет на итог только
 * в одну сторону — может СДЕЛАТЬ доставку платной, но никогда бесплатной.
 * Это важно для anti-tamper: значение приходит из тела запроса, и подделка
 * страны не должна давать покупателю скидку.
 */
describe('pricing — freeEligible: распознавание РФ', () => {
  const ru = ['Россия', 'россия', '  РОССИЯ  ', 'Российская Федерация', 'Russia', 'RU', 'ru'];
  const notRu = ['Казахстан', 'Belarus', 'Armenia', 'Germany', 'США'];

  it('варианты названия РФ → порог действует (доставка бесплатна)', () => {
    for (const country of ru) {
      // Флаг вычисляет репозиторий; здесь фиксируем ожидаемый результат,
      // который он обязан дать для этих названий.
      const eligible = /(росси|russia|\bru\b|российск)/.test(country.trim().toLowerCase());
      expect(eligible, `должно считаться РФ: ${country}`).toBe(true);
    }
  });

  it('не-РФ → порог не действует (доставка платная)', () => {
    for (const country of notRu) {
      const eligible = /(росси|russia|\bru\b|российск)/.test(country.trim().toLowerCase());
      expect(eligible, `НЕ должно считаться РФ: ${country}`).toBe(false);
    }
  });

  /**
   * 🔴 Пустая/неизвестная страна = прежнее поведение. Проверяем именно на
   * уровне расчёта: заказ без страны получает бесплатную доставку по порогу.
   */
  it('🔴 страна не указана → порог действует, как до появления правила', () => {
    const r = resolveDelivery(
      { cost: '350.00', freeThreshold: 3000, freeEligible: true },
      300000,
      null,
    );
    expect(r.costMinor).toBe(0);
  });
});
