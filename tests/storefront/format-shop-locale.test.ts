import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * №9: формат чисел витрины должен идти из НАСТРОЕК МАГАЗИНА, а не из жёсткого
 * 'ru-RU'.
 *
 * ДЕФЕКТ. storefront/lib/format.ts звал new Intl.NumberFormat('ru-RU', …) в обеих
 * функциях, currency.tsx возвращал fractionDigits: 0 КОНСТАНТОЙ, а grep
 * `currency.locale` по storefront давал ноль вхождений. Настройки магазина
 * «Формат чисел» (currency.locale) и «Знаков после запятой» (currency.fractionDigits)
 * витрина игнорировала полностью — мультитенантный магазин на en/fr показывал
 * русскую группировку разрядов.
 *
 * Импорт относительным путём: storefront — отдельное Next-приложение со своим
 * алиасом @, поэтому standalone-модуль тянем напрямую по пути.
 */

import {
  formatDisplayPrice,
  formatPrice,
  type DisplayCurrency,
} from '../../storefront/lib/format';

/** Нормализуем ЛЮБОЙ пробел-разделитель разрядов (NBSP/NNBSP) к ASCII. */
const p = (s: string): string => s.replace(/[   ]/g, ' ');

const RUB: DisplayCurrency = { code: 'RUB', symbol: '₽', rate: 1, fractionDigits: 0 };

describe('formatDisplayPrice — локаль формата из настроек магазина', () => {
  it('де-факто анти-регресс: без локали формат прежний (ru-RU, пробел разрядов)', () => {
    expect(p(formatDisplayPrice('7500.00', RUB))).toBe('7 500 ₽');
  });

  it('en-US: разряды запятой (магазин, у которого «Формат чисел» = en-US)', () => {
    const usd: DisplayCurrency = {
      code: 'USD',
      symbol: '$',
      rate: 1,
      fractionDigits: 2,
      locale: 'en-US',
    };
    expect(formatDisplayPrice('7500.5', usd)).toBe('7,500.50 $');
  });

  it('de-DE: разряды точкой, дробь запятой', () => {
    const eur: DisplayCurrency = {
      code: 'EUR',
      symbol: '€',
      rate: 1,
      fractionDigits: 2,
      locale: 'de-DE',
    };
    expect(formatDisplayPrice('7500.5', eur)).toBe('7.500,50 €');
  });

  it('битая локаль из настроек не роняет витрину (фолбэк на дефолт)', () => {
    const broken: DisplayCurrency = { ...RUB, locale: 'не-локаль-вовсе!!' };
    // Главное — не исключение RangeError; формат деградирует к дефолтному.
    const out = formatDisplayPrice('7500.00', broken);
    expect(typeof out).toBe('string');
    expect(out).toContain('₽');
  });
});

describe('formatPrice (легаси-форматтер) — принимает локаль и знаки', () => {
  it('анти-регресс: без опций — прежний рублёвый показ целыми', () => {
    expect(p(formatPrice('7500.00', 'RUB'))).toBe('7 500 ₽');
  });

  it('локаль магазина применяется к группировке разрядов', () => {
    expect(formatPrice('7500', 'USD', '$', { locale: 'en-US' })).toBe('7,500 $');
  });

  it('fractionDigits магазина уважается (не жёсткий 0)', () => {
    expect(formatPrice('7500.5', 'USD', '$', { locale: 'en-US', fractionDigits: 2 })).toBe(
      '7,500.50 $',
    );
  });

  it('битая локаль не роняет (фолбэк)', () => {
    const out = formatPrice('7500', 'RUB', '₽', { locale: '!!!' });
    expect(typeof out).toBe('string');
    expect(out).toContain('₽');
  });
});

describe('источник — витрина больше не хардкодит ru-RU', () => {
  const STOREFRONT = resolve(__dirname, '../../storefront');
  const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

  /**
   * Сравниваем по КОДУ, а не по сырому тексту: пояснительные комментарии
   * («раньше здесь стояло Intl.NumberFormat('ru-RU')») цитируют прежний дефект
   * намеренно, и текстовый матч ловил бы их как регресс.
   */
  const code = (rel: string): string =>
    src(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '') // блочные комментарии
      .replace(/^\s*\/\/.*$/gm, ''); // строчные комментарии

  it('format.ts не содержит литерала ru-RU в вызове Intl', () => {
    expect(code('lib/format.ts')).not.toMatch(/Intl\.NumberFormat\(\s*'ru-RU'/);
  });

  it('ru-RU остался ТОЛЬКО как именованный дефолт (а не разбросан по вызовам)', () => {
    const c = code('lib/format.ts');
    expect(c).toContain('DEFAULT_NUMBER_LOCALE');
    // Единственное вхождение литерала — объявление константы-дефолта.
    expect((c.match(/'ru-RU'/g) ?? []).length).toBe(1);
  });

  it('currency.tsx берёт fractionDigits/locale базовой валюты из настроек', () => {
    const s = src('lib/currency.tsx');
    expect(s).toContain('currency?.fractionDigits');
    expect(s).toContain('currency?.locale');
    // Жёсткая константа `fractionDigits: 0` для базовой валюты — ровно тот дефект.
    expect(s).not.toMatch(/rate: 1, fractionDigits: 0 \}\;?\s*\n\}/);
  });

  it('GiftCodes.tsx не склеивает сумму через toLocaleString(\'ru-RU\')', () => {
    const c = code('app/[lang]/cart/success/GiftCodes.tsx');
    expect(c).not.toContain("toLocaleString('ru-RU')");
    // Номинал сертификата идёт через общий форматтер, знающий настройки магазина.
    expect(c).toContain('formatPrice');
    expect(c).toContain('numberFormat');
  });
});
