import { describe, it, expect } from 'vitest';

import { computeCoverage } from '@/lib/i18n/coverage';
import type { TranslationsMap } from '@/lib/i18n/types';

/**
 * i18n coverage (ADR-i18n, docs/24 §1): матрица заполненности оверлея для
 * дашборда «Языки». Чисто, без БД.
 */

function row(t: TranslationsMap | null): { translations: TranslationsMap | null } {
  return { translations: t };
}

describe('computeCoverage', () => {
  const fields = ['name', 'description'] as const;
  const locales = ['en', 'fr'] as const;

  it('пустая выборка → нулевые счётчики, ratio 0', () => {
    const cov = computeCoverage([], locales, fields);
    expect(cov.total).toBe(0);
    expect(cov.locales.en!.overall).toEqual({ filled: 0, missing: 0, ratio: 0 });
    expect(cov.locales.en!.fields.name).toEqual({ filled: 0, missing: 0, ratio: 0 });
  });

  it('считает заполненность по каждому (язык × поле)', () => {
    const rows = [
      row({ en: { name: 'A', description: 'a' }, fr: { name: 'A-fr' } }),
      row({ en: { name: 'B' } }),
      row(null),
    ];
    const cov = computeCoverage(rows, locales, fields);

    expect(cov.total).toBe(3);
    // en.name заполнен в 2 из 3 строк.
    expect(cov.locales.en!.fields.name).toEqual({ filled: 2, missing: 1, ratio: 2 / 3 });
    // en.description заполнен только в 1 строке.
    expect(cov.locales.en!.fields.description).toEqual({ filled: 1, missing: 2, ratio: 1 / 3 });
    // fr.name — 1, fr.description — 0.
    expect(cov.locales.fr!.fields.name!.filled).toBe(1);
    expect(cov.locales.fr!.fields.description!.filled).toBe(0);
  });

  it('overall агрегирует по всем полям языка', () => {
    const rows = [row({ en: { name: 'A', description: 'a' } })];
    const cov = computeCoverage(rows, locales, fields);
    // en: 2 поля заполнены из 1×2 = 2.
    expect(cov.locales.en!.overall).toEqual({ filled: 2, missing: 0, ratio: 1 });
    // fr: 0 из 2.
    expect(cov.locales.fr!.overall).toEqual({ filled: 0, missing: 2, ratio: 0 });
  });

  it('пустые/пробельные строки не считаются заполненными', () => {
    const rows = [row({ en: { name: '   ', description: '' } })];
    const cov = computeCoverage(rows, locales, fields);
    expect(cov.locales.en!.fields.name!.filled).toBe(0);
    expect(cov.locales.en!.fields.description!.filled).toBe(0);
  });
});
