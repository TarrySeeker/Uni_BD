import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C7. ОПЛАТА ВСЕГДА В БАЗОВОЙ ВАЛЮТЕ (для этого магазина — рубли).
 *
 * Валюта отображения (мультивалюта ₽/€/$) — ТОЛЬКО показ цены на витрине; курс
 * пересчёта берётся с ЦБ или задан вручную и меняется ежедневно. Если он хоть
 * где-то просочится в путь оформления заказа или в платёжный адаптер, покупателя
 * спишут не на ту сумму, а сверка с эквайером развалится.
 *
 * ФАКТ, зафиксированный этим тестом (проверено по коду):
 *  • платёжные адаптеры (tbank/paykeeper/alfabank) берут сумму ИСКЛЮЧИТЕЛЬНО из
 *    order.grandTotal, посчитанного сервером, и не знают ни о курсе, ни о валюте
 *    отображения;
 *  • форма чекаута форматирует суммы по settings.currency (БАЗОВОЙ валюте),
 *    а не по выбранной покупателем валюте показа (useCurrency).
 *
 * Guard по исходникам (тестов React-компонентов в проекте нет): нужный вызов ЕСТЬ
 * и антипаттерн ЗАПРЕЩЁН.
 */

const ROOT = resolve(__dirname, '../..');

/** Все .ts-файлы платёжного слоя. */
function paymentSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(ROOT, 'lib/payments'));
  return out;
}

describe('платёжные адаптеры не знают о валюте отображения', () => {
  const files = paymentSources();

  it('в lib/payments найдены исходники (иначе тест бессмысленно зелёный)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('ни один адаптер не импортирует курс/мультивалюту', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return (
        src.includes('lib/exchange') ||
        src.includes('displayCurrencies') ||
        src.includes('exchange.autoRate')
      );
    });
    expect(offenders).toEqual([]);
  });

  it('сумма инициации платежа берётся из серверного grandTotal', () => {
    for (const provider of ['tbank', 'paykeeper', 'alfabank']) {
      const src = readFileSync(join(ROOT, `lib/payments/${provider}/service.ts`), 'utf8');
      expect(src).toContain('order.grandTotal');
      // АНТИПАТТЕРН: пересчёт суммы по курсу перед отправкой эквайеру.
      expect(src).not.toMatch(/\/\s*rate\b/);
      expect(src).not.toContain('selectedCurrency');
    }
  });
});

describe('чекаут витрины считает и показывает суммы в базовой валюте', () => {
  const page = readFileSync(
    join(ROOT, 'storefront/app/[lang]/cart/order/page.tsx'),
    'utf8',
  );
  const form = readFileSync(
    join(ROOT, 'storefront/app/[lang]/cart/order/CheckoutForm.tsx'),
    'utf8',
  );

  it('валюта чекаута = базовая валюта магазина из настроек', () => {
    expect(page).toContain('settings?.currency.code');
    expect(page).toContain('currencyCode={currencyCode}');
  });

  it('АНТИПАТТЕРН: чекаут НЕ использует выбранную валюту показа', () => {
    // useCurrency/displayCurrencies — стор ПОКАЗА (шапка, карточка, корзина).
    // В оформлении заказа их быть не должно: платят в базовой валюте.
    for (const src of [page, form]) {
      expect(src).not.toContain('useCurrency');
      expect(src).not.toContain('displayCurrencies');
    }
  });

  it('АНТИПАТТЕРН: сумма не делится на курс перед отправкой заказа', () => {
    expect(form).not.toMatch(/\/\s*(rate|selected\.rate)\b/);
  });
});
