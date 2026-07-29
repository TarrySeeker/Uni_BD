import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';

/**
 * GUARD: покупатель ЗНАЕТ, что спишут рубли, хотя смотрел цены в евро (ЭТАП 1).
 *
 * ДЕФЕКТ (главный риск мультивалютности). Переключатель ₽/€ в шапке живой, курс
 * ЦБ РФ обновляется кроном, весь каталог и корзина показываются в выбранной
 * валюте. А эквайринг РУБЛЁВЫЙ: адаптеры lib/payments берут сумму из
 * `order.grandTotal` в базовой валюте и о курсе не знают (это отдельно защищено
 * tests/exchange/payment-base-currency.test.ts). Чекаут о выборе покупателя не
 * знал вовсе и молча форматировал всё в ₽ — человек, пришедший из евро-режима,
 * видел «внезапно другие» суммы без единого слова объяснения и уходил на шлюз,
 * где списание тоже в рублях. Технически безопасно, для покупателя — обман
 * ожиданий и повод для претензии/чарджбэка.
 *
 * ЧТО СТОРОЖИМ:
 *   1) суммы формы чекаута ОСТАЮТСЯ В БАЗОВОЙ ВАЛЮТЕ — дисклеймер ПОЯСНЯЕТ, а не
 *      пересчитывает форму (guard payment-base-currency НЕ ослаблен);
 *   2) дисклеймер существует отдельным компонентом и показывается ТОЛЬКО когда
 *      выбрана НЕ базовая валюта (рублёвому покупателю его не показывают вовсе,
 *      одновалютный магазин платформы не видит ничего — мультитенантность);
 *   3) справочная сумма считается ОТ ИТОГА (÷ rate), а не суммированием позиций;
 *   4) переключателя валют на чекауте НЕТ (точка оплаты — не место менять валюту);
 *   5) текст — из словаря на всех трёх языках, с плейсхолдерами и без хардкода.
 *
 * storefront/ вне корневого tsconfig и не покрыт React-тестами (environment
 * 'node') — сторожим СУТЬ чтением исходника, как соседние guard-ы.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const NOTICE = 'storefront/app/[lang]/cart/order/PaymentCurrencyNotice.tsx';
const FORM = 'storefront/app/[lang]/cart/order/CheckoutForm.tsx';

const LOCALES: Locale[] = ['ru', 'en', 'fr'];

describe('дисклеймер о валюте списания — компонент', () => {
  const notice = read(NOTICE);

  it('это клиентский компонент и он читает ВЫБРАННУЮ валюту показа', () => {
    expect(notice).toContain("'use client'");
    expect(notice).toContain('useCurrency');
  });

  it('🔴 базовая валюта → дисклеймера НЕТ вовсе (не мозолить глаза рублёвому покупателю)', () => {
    // Ранний выход обязан быть: рендерить «оплата в рублях» рублёвому покупателю —
    // шум, а одновалютному магазину платформы — регресс на пустом месте.
    expect(notice).toMatch(/return null/);
    // Признак базовой валюты — rate === 1 (так же, как в корзине).
    expect(notice).toMatch(/rate\s*===\s*1|isBase/);
  });

  it('🔴 справочная сумма считается ОТ ИТОГА, а не суммированием позиций', () => {
    // Единственный вход — рублёвый ИТОГ заказа; из него и берётся эквивалент.
    expect(notice).toMatch(/grandTotal|totalBase/);
    expect(notice).toContain('formatDisplayPrice');
  });

  it('текст берётся из словаря (никакого «Оплата производится в рублях» в коде)', () => {
    expect(notice).not.toMatch(/Оплата производится/);
    expect(notice).not.toMatch(/Payment is (made|charged)/);
    expect(notice).toMatch(/dict\.checkout|t\.paymentCurrency/);
  });

  it('🔴 переключателя валют на чекауте НЕТ — это точка оплаты', () => {
    expect(notice).not.toContain('setCurrency');
  });
});

describe('форма чекаута: суммы остаются в БАЗОВОЙ валюте', () => {
  const form = read(FORM);

  it('🔴 форма НЕ пересчитывает свои суммы по курсу (guard C7 не ослаблен)', () => {
    // Ровно те же антипаттерны, что стережёт tests/exchange/payment-base-currency:
    // деление на курс и обращение к валюте показа в самой форме.
    expect(form).not.toContain('useCurrency');
    expect(form).not.toContain('displayCurrencies');
    expect(form).not.toMatch(/\/\s*(rate|selected\.rate)\b/);
  });

  it('форма рендерит дисклеймер, передавая ему СЕРВЕРНЫЙ итог', () => {
    expect(form).toContain('PaymentCurrencyNotice');
    // Итог — только из ответа сервера (/cart/quote), не из клиентской арифметики.
    // Сторожим САМ JSX-вызов (<PaymentCurrencyNotice …/>), а не строку импорта.
    expect(form).toMatch(/<PaymentCurrencyNotice[\s\S]{0,240}quote\??\.grandTotal/);
  });

  it('🔴 в заказ уходит КОД валюты показа, но НИКОГДА не курс и не сумма в ней', () => {
    // ЭТАП 2: снимок в БД заполняет сервер. Клиент вправе сообщить лишь то, что
    // видел, — код валюты; курс/сумму сервер считает сам (ADR-010 anti-tamper).
    expect(form).toContain('displayCurrency');
    expect(form).not.toMatch(/displayRate|displayTotal/);
  });
});

describe('тексты дисклеймера — три языка, осмысленный перевод', () => {
  it('ключи есть во всех локалях и непусты', () => {
    for (const locale of LOCALES) {
      const t = getDictionary(locale).checkout;
      expect(t.paymentCurrencyNotice, `paymentCurrencyNotice/${locale}`).toBeTruthy();
      expect(t.paymentCurrencyRate, `paymentCurrencyRate/${locale}`).toBeTruthy();
    }
  });

  it('плейсхолдеры одинаковы во всех локалях (иначе подстановка сумм развалится)', () => {
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const ru = getDictionary('ru').checkout;
    for (const locale of LOCALES) {
      const t = getDictionary(locale).checkout;
      expect(placeholders(t.paymentCurrencyNotice), `notice/${locale}`).toEqual(
        placeholders(ru.paymentCurrencyNotice),
      );
      expect(placeholders(t.paymentCurrencyRate), `rate/${locale}`).toEqual(
        placeholders(ru.paymentCurrencyRate),
      );
    }
  });

  it('в тексте названы ОБЕ суммы: списываемая и справочная', () => {
    for (const locale of LOCALES) {
      const t = getDictionary(locale).checkout;
      expect(t.paymentCurrencyNotice, `notice/${locale}`).toContain('{charged}');
      expect(t.paymentCurrencyNotice, `notice/${locale}`).toContain('{approx}');
    }
  });

  it('🔴 en/fr — НЕ копия русского (иначе покупатель читает чужой язык)', () => {
    const ru = getDictionary('ru').checkout;
    for (const locale of ['en', 'fr'] as Locale[]) {
      const t = getDictionary(locale).checkout;
      expect(t.paymentCurrencyNotice).not.toBe(ru.paymentCurrencyNotice);
      expect(t.paymentCurrencyRate).not.toBe(ru.paymentCurrencyRate);
      // Кириллицы в переводе быть не должно вовсе.
      expect(t.paymentCurrencyNotice, `notice/${locale}`).not.toMatch(/[а-яА-ЯёЁ]/);
      expect(t.paymentCurrencyRate, `rate/${locale}`).not.toMatch(/[а-яА-ЯёЁ]/);
    }
  });
});
