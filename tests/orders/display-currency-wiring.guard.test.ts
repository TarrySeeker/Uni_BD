import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { CreateOrderSchema } from '@/lib/orders/schemas';

/**
 * GUARD: снимок валюты отображения (0059) заполняется ТОЛЬКО СЕРВЕРОМ.
 *
 * Риск, который сторожим: справочные поля `orders.display_*` соблазнительно
 * заполнить прямо из тела запроса — витрина ведь «уже знает» и курс, и сумму в
 * евро. Тогда подделка тела нарисовала бы в карточке заказа любой «курс», по
 * которому покупатель потом требует перерасчёта, а менеджер видел бы ложь как
 * зафиксированный факт. ADR-010: клиентское число к деньгам не допускается — даже
 * к справочным.
 *
 * Правила:
 *   1) контракт /orders принимает КОД валюты и НЕ принимает ни курс, ни сумму;
 *   2) в репозитории значения приходят из резолвера (настройки магазина +
 *      серверный итог), а не из `input.*`;
 *   3) `grand_total` и платёжный путь от новых колонок не зависят.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

describe('контракт /orders: только КОД валюты отображения', () => {
  const validBody = {
    items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
    customer: { name: 'Иван', email: 'i@example.com', phone: '+79990000000' },
    delivery: { type: 'pickup' as const },
    paymentMethod: 'card' as const,
  };

  it('принимает displayCurrency (3-буквенный код)', () => {
    const parsed = CreateOrderSchema.safeParse({ ...validBody, displayCurrency: 'EUR' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayCurrency).toBe('EUR');
  });

  it('поле опционально — старый клиент без него работает как раньше', () => {
    const parsed = CreateOrderSchema.safeParse(validBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayCurrency).toBeUndefined();
  });

  it('мусор вместо кода отвергается схемой', () => {
    for (const bad of ['EURO', '€', '12', '']) {
      expect(
        CreateOrderSchema.safeParse({ ...validBody, displayCurrency: bad }).success,
        `должно быть отвергнуто: ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });

  it('🔴 курс и сумма в валюте показа В КОНТРАКТЕ ОТСУТСТВУЮТ (strip)', () => {
    const parsed = CreateOrderSchema.safeParse({
      ...validBody,
      displayCurrency: 'EUR',
      displayRate: '1.0',
      displayTotal: '1.00',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('displayRate');
      expect(parsed.data).not.toHaveProperty('displayTotal');
    }
  });
});

describe('репозиторий: снимок считает сервер', () => {
  const repo = read('lib/orders/repository.ts');

  it('значения берутся из резолвера, а не из тела запроса', () => {
    expect(repo).toContain('resolveDisplaySnapshot');
    // Единственное клиентское поле в аргументах резолвера — КОД валюты.
    expect(repo).toMatch(/requestedCurrency:\s*input\.displayCurrency/);
    // Курс/сумма из тела запроса в INSERT не попадают ни под каким видом.
    expect(repo).not.toMatch(/input\.displayRate|input\.displayTotal/);
  });

  it('справочная сумма считается от СЕРВЕРНОГО итога (после промо/доставки/сертификата)', () => {
    expect(repo).toMatch(/grandTotal:\s*finalGrandTotal/);
  });

  it('🔴 grand_total по-прежнему пишется из серверного расчёта, а не из снимка', () => {
    // Итог к оплате — только finalGrandTotal; подстановка displayTotal сюда была
    // бы списанием евро-числа рублями.
    expect(repo).toContain('${finalGrandTotal}, ${orderCurrency}');
    expect(repo).not.toMatch(/\$\{displaySnapshot[^}]*\}\s*,\s*\$\{orderCurrency\}/);
  });
});

describe('платёжный слой не видит новых колонок', () => {
  it('🔴 lib/payments не упоминает display_* / displayTotal (оплата в базовой валюте)', () => {
    for (const provider of ['tbank', 'paykeeper', 'alfabank']) {
      const src = read(`lib/payments/${provider}/service.ts`);
      expect(src, provider).not.toMatch(/display_?(currency|rate|total)/i);
    }
  });
});
