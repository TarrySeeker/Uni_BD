import { describe, it, expect } from 'vitest';

import { computeCoverage } from '@/lib/i18n/coverage';
import {
  buildCoverageMatrix,
  percentOf,
  formatPercent,
  coverageTone,
} from '@/app/admin/(panel)/settings/_components/languages-coverage';

/**
 * T3 — матрица покрытия переводов для экрана «Языки».
 *
 * computeCoverage (lib/i18n/coverage.ts) уже был покрыт тестами, но НИ ОДИН
 * потребитель его не звал. Здесь тестируется слой представления: сборка матрицы
 * «сущность × язык» из результатов computeCoverage и её форматирование. Логика
 * чистая (без БД/DOM) — страница только подставляет строки из БД.
 */

const FIELDS = ['name', 'description'] as const;

function coverageOf(rows: Array<{ translations?: Record<string, Record<string, unknown>> }>) {
  return computeCoverage(rows, ['en', 'fr'], [...FIELDS]);
}

describe('languages-coverage — buildCoverageMatrix', () => {
  const products = coverageOf([
    { translations: { en: { name: 'Scarf', description: 'Silk' } } },
    { translations: { en: { name: 'Shawl' } } },
    { translations: {} },
  ]);
  const brands = coverageOf([{ translations: { en: { name: 'B' }, fr: { name: 'B' } } }]);

  const matrix = buildCoverageMatrix(
    [
      { entity: 'products', labelKey: 'settings.languagesPage.entities.products', coverage: products },
      { entity: 'brands', labelKey: 'settings.languagesPage.entities.brands', coverage: brands },
    ],
    ['en', 'fr'],
  );

  it('строка на сущность, ячейка на язык — в переданном порядке', () => {
    expect(matrix.map((r) => r.entity)).toEqual(['products', 'brands']);
    expect(matrix[0].cells.map((c) => c.locale)).toEqual(['en', 'fr']);
  });

  it('КЛЮЧ подписи сущности доезжает до строки матрицы (подпись резолвит render-сайт)', () => {
    expect(matrix.map((r) => r.labelKey)).toEqual([
      'settings.languagesPage.entities.products',
      'settings.languagesPage.entities.brands',
    ]);
  });

  it('несёт число строк и абсолютные счётчики (не только проценты)', () => {
    expect(matrix[0].total).toBe(3);
    const en = matrix[0].cells[0];
    // 3 строки × 2 поля = 6 слотов; заполнено name+description и ещё один name.
    expect(en.filled).toBe(3);
    expect(en.missing).toBe(3);
    expect(en.percent).toBe(50);
  });

  it('полностью незаполненный язык → 0 %', () => {
    const fr = matrix[0].cells[1];
    expect(fr.filled).toBe(0);
    expect(fr.percent).toBe(0);
  });

  it('полностью заполненный язык → 100 %', () => {
    const brandsRow = matrix[1];
    // У бренда переведено только name из двух полей → 50 %, а по полю name — 100 %.
    expect(brandsRow.cells[0].percent).toBe(50);
    expect(brandsRow.cells[0].fields.name.percent).toBe(100);
  });

  it('сущность без строк не делит на ноль', () => {
    const empty = buildCoverageMatrix(
      [{ entity: 'news', labelKey: 'nav.news', coverage: coverageOf([]) }],
      ['en'],
    );
    expect(empty[0].total).toBe(0);
    expect(empty[0].cells[0].percent).toBe(0);
  });

  it('язык, которого нет в результате покрытия, даёт пустую ячейку, а не падение', () => {
    const m = buildCoverageMatrix(
      [{ entity: 'products', labelKey: 'settings.languagesPage.entities.products', coverage: products }],
      ['en', 'de'],
    );
    expect(m[0].cells[1].locale).toBe('de');
    expect(m[0].cells[1].percent).toBe(0);
  });
});

describe('languages-coverage — форматирование', () => {
  it('percentOf округляет долю до целых процентов', () => {
    expect(percentOf(0)).toBe(0);
    expect(percentOf(1)).toBe(100);
    expect(percentOf(1 / 3)).toBe(33);
  });

  it('formatPercent отдаёт человекочитаемую подпись', () => {
    expect(formatPercent(0.5)).toBe('50 %');
  });

  it('coverageTone различает пусто/мало/частично/полно', () => {
    expect(coverageTone(0)).toBe('none');
    expect(coverageTone(0.2)).toBe('low');
    expect(coverageTone(0.7)).toBe('mid');
    expect(coverageTone(1)).toBe('full');
  });
});
