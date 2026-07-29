import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';

/**
 * GUARD аудита major №19 + №20 — покупатель не должен попадать в тупик из-за СДЭК.
 *
 * №19: сбой СДЭК рисовался как «в этом городе нет пунктов выдачи», а у автокомплита
 *      городов при пустом результате не рисовалось НИЧЕГО. Правило: витрина различает
 *      «пусто» и «сервис недоступен» (api-функции отдают { items, failed }) и в обоих
 *      случаях объясняет покупателю, что происходит и что делать.
 * №20: при выключенном модуле cdek радио «Курьер СДЭК»/«Пункт выдачи СДЭК» рисовались
 *      БЕЗУСЛОВНО. Правило: витрина рендерит способ доставки только если он есть в
 *      публичном контракте возможностей settings.delivery.methods.
 *
 * Файлы — Next/React-модули; сторожим СУТЬ чтением исходника (как соседние guard-ы).
 */

const ROOT = resolve(__dirname, '../..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const LOCALES: Locale[] = ['ru', 'en', 'fr'];

describe('словарь — тексты сбоя СДЭК и отсутствия способов есть во ВСЕХ локалях', () => {
  const KEYS = [
    'cityLookupFailed',
    'cityLookupEmpty',
    'pvzLookupFailed',
    'deliveryNoMethods',
  ] as const;

  for (const locale of LOCALES) {
    it(`${locale}: все ключи непустые и не совпадают с ключом`, () => {
      const t = getDictionary(locale).checkout as unknown as Record<string, unknown>;
      for (const key of KEYS) {
        const value = t[key];
        expect(typeof value, `${locale}.${key}`).toBe('string');
        expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('переводы en/fr не остались русскими (кириллицы нет)', () => {
    for (const locale of ['en', 'fr'] as Locale[]) {
      const t = getDictionary(locale).checkout as unknown as Record<string, unknown>;
      for (const key of KEYS) {
        expect(t[key] as string, `${locale}.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it('ru/en/fr дают РАЗНЫЕ строки (переводы, а не копия ru)', () => {
    for (const key of KEYS) {
      const ru = (getDictionary('ru').checkout as unknown as Record<string, string>)[key];
      const en = (getDictionary('en').checkout as unknown as Record<string, string>)[key];
      const fr = (getDictionary('fr').checkout as unknown as Record<string, string>)[key];
      expect(new Set([ru, en, fr]).size, key).toBe(3);
    }
  });
});

describe('api.ts — cdek-функции больше не глотают ошибку в пустой массив (№19)', () => {
  const source = () => src('storefront/lib/api.ts');

  it('нет немого `catch { return []; }` в cdek-функциях', () => {
    const s = source();
    const cdekBlock = s.slice(s.indexOf('export async function cdekCities'));
    const upToNext = cdekBlock.slice(0, cdekBlock.indexOf('export async function getOrder'));
    expect(upToNext).not.toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });

  it('обе функции возвращают результат с признаком сбоя (CdekLookupResult)', () => {
    const s = source();
    expect(s).toContain('CdekLookupResult');
    expect(s).toMatch(/cdekCities\([^)]*\)[^{]*Promise<CdekLookupResult<CdekCityDto>>/s);
    expect(s).toMatch(/cdekPvz\([\s\S]*?\)\s*:\s*Promise<CdekLookupResult<CdekPvzDto>>/);
  });

  it('признак сбоя различает «модуль/сервис недоступен» и прочую ошибку', () => {
    const s = source();
    expect(s).toContain("'unavailable'");
    expect(s).toContain("'error'");
  });
});

describe('CheckoutForm — сбой СДЭК объясняется, а недоступный способ не предлагается', () => {
  const source = () => src('storefront/app/[lang]/cart/order/CheckoutForm.tsx');

  it('город: отдельные состояния сбоя и пустого результата (не молчание)', () => {
    const s = source();
    expect(s).toContain('cityLookupFailed');
    expect(s).toContain('cityLookupEmpty');
  });

  it('ПВЗ: «нет пунктов» показывается ТОЛЬКО когда сервис ответил', () => {
    const s = source();
    expect(s).toContain('pvzLookupFailed');
    // pvzEmpty остаётся, но уже под условием «сбоя не было».
    expect(s).toContain('pvzEmpty');
  });

  it('радио СДЭК гейтятся доступными способами доставки, а не рисуются безусловно (№20)', () => {
    const s = source();
    expect(s).toContain('cdekCourierAvailable');
    expect(s).toContain('cdekPvzAvailable');
    // Оба cdek-радио — под условием доступности.
    expect(s).toMatch(/cdekCourierAvailable\s*&&\s*\(/);
    expect(s).toMatch(/cdekPvzAvailable\s*&&\s*\(/);
  });

  it('ни одного доступного способа → покупателю объясняют (deliveryNoMethods)', () => {
    expect(source()).toContain('deliveryNoMethods');
  });

  it('нет русских литералов в UI (кириллица — только в комментариях и в логах для поддержки)', () => {
    const s = source();
    const withoutComments = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Диагностика уходит в консоль браузера (для поддержки), а не покупателю —
    // строки внутри console.* исключаем из проверки.
    const withoutLogs = withoutComments.replace(/console\.\w+\([^)]*\)/g, '');
    const cyrillicLiterals = withoutLogs.match(/(['"`])[^'"`\n]*[А-Яа-яЁё][^'"`\n]*\1/g) ?? [];
    expect(cyrillicLiterals).toEqual([]);
  });
});

describe('витрина знает доступные способы доставки из публичного DTO (№20)', () => {
  it('тип PublicSettingsDto.delivery несёт methods', () => {
    expect(src('storefront/lib/types.ts')).toMatch(/methods\??:\s*(string|DeliveryMethod)/);
  });

  it('страница чекаута пробрасывает методы в форму', () => {
    const s = src('storefront/app/[lang]/cart/order/page.tsx');
    expect(s).toContain('methods');
    expect(s).toMatch(/deliveryMethods=\{/);
  });
});
