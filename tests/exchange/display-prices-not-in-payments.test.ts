import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 GUARD ЭТАПА 3: ручная цена отображения (products.display_prices) НЕ ДОЛЖНА
 * просочиться в путь денег.
 *
 * Модель: base_price в рублях — единственный источник истины для сумм (корзина,
 * заказ, эквайринг). display_prices — ТОЛЬКО показ ценника. Если владелец задал
 * «480 €» при курсе 88,76, покупатель видит 480 € и 42 605 ₽, а платит 42 605 ₽.
 * Стоит оверрайду попасть в расчёт итога — суммы строк перестанут сходиться с
 * итогом, а списание разойдётся с показанным. Тест сторожит это по ИСХОДНИКУ,
 * как соседний payment-base-currency.test.ts.
 */

const ROOT = join(__dirname, '..', '..');

function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTs(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const MARKERS = ['display_prices', 'displayPrices'];

describe('display_prices — оверрайд не виден платёжному слою', () => {
  it('контроль: файлы lib/payments найдены', () => {
    const files = collectTs(join(ROOT, 'lib', 'payments'));
    expect(files.length).toBeGreaterThan(10);
  });

  it('🔴 ни один файл lib/payments не упоминает display_prices/displayPrices', () => {
    for (const f of collectTs(join(ROOT, 'lib', 'payments'))) {
      const src = readFileSync(f, 'utf8');
      for (const marker of MARKERS) {
        expect(
          src.includes(marker),
          `${f.replace(ROOT, '')} упоминает ${marker} — оверрайд показа попал в путь оплаты`,
        ).toBe(false);
      }
    }
  });

  it('🔴 слой заказов (суммы) не знает о display_prices', () => {
    // orders считает grand_total от рублёвых цен; ручная цена показа здесь
    // означала бы расхождение списания с заказом.
    for (const f of collectTs(join(ROOT, 'lib', 'orders'))) {
      const src = readFileSync(f, 'utf8');
      for (const marker of MARKERS) {
        expect(
          src.includes(marker),
          `${f.replace(ROOT, '')} упоминает ${marker} — оверрайд показа попал в расчёт заказа`,
        ).toBe(false);
      }
    }
  });

  it('🔴 ИТОГ корзины считается от рублёвых сумм, а не от ручных цен', () => {
    // Иначе строки не сойдутся с суммой: оверрайд задан не для всех товаров.
    const cart = readFileSync(join(ROOT, 'storefront', 'lib', 'cart.ts'), 'utf8');
    for (const marker of MARKERS) expect(cart.includes(marker)).toBe(false);

    const page = readFileSync(
      join(ROOT, 'storefront', 'app', '[lang]', 'cart', 'page.tsx'),
      'utf8',
    );
    // Итог к оплате — от subtotal в базовой валюте, без карты оверрайдов.
    expect(page).toMatch(/formatDisplayPrice\(subtotal,\s*base\)/);
  });

  it('🔴 чекаут не видит ручных цен', () => {
    for (const rel of [
      ['storefront', 'app', '[lang]', 'cart', 'order', 'page.tsx'],
      ['storefront', 'app', '[lang]', 'cart', 'order', 'CheckoutForm.tsx'],
    ]) {
      const src = readFileSync(join(ROOT, ...rel), 'utf8');
      for (const marker of MARKERS) {
        expect(src.includes(marker), `${rel.join('/')} упоминает ${marker}`).toBe(false);
      }
    }
  });
});
