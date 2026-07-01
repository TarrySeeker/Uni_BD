import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ЮНИТ loadPromoPickerData — целевая проверка C5 (варианты не грузились в picker
 * таргетов промокода). app/admin/(panel)/promo/_components/picker-data.ts.
 *
 * Мок (паттерн tests/catalog/move-category-toctou.test.ts): sql — tagged-template-
 * спай (для запроса вариантов FROM product_variants отдаёт засеянные строки, иначе
 * пусто), @/lib/catalog/repository — listBrands/getCategoryTree → []. БЕЗ БД/Next.
 *
 * picker-data.ts начинается с `import 'server-only'` (шим Next, отдельным пакетом
 * не ставится) — мокаем пустым модулем, чтобы юнит грузился в node-окружении.
 *
 * Регресс-цель: тест ПАДАЛ БЫ на старом коде — ключа variant в результате не было.
 */

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => {
  const state = { variantRows: [] as { id: string; name: string }[] };
  const sqlMock = vi.fn((strings: TemplateStringsArray) => {
    const text = Array.from(strings).join('?');
    if (text.includes('product_variants')) {
      return Promise.resolve(state.variantRows);
    }
    return Promise.resolve([] as unknown[]);
  });
  return {
    state,
    sqlMock,
    listBrandsMock: vi.fn(async () => [] as { id: string; name: string }[]),
    getCategoryTreeMock: vi.fn(async () => [] as unknown[]),
  };
});

vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));
vi.mock('@/lib/catalog/repository', () => ({
  listBrands: H.listBrandsMock,
  getCategoryTree: H.getCategoryTreeMock,
}));

// Импорт ПОСЛЕ моков.
import { loadPromoPickerData } from '@/app/admin/(panel)/promo/_components/picker-data';

beforeEach(() => {
  H.state.variantRows = [];
  H.sqlMock.mockClear();
  H.listBrandsMock.mockClear();
  H.getCategoryTreeMock.mockClear();
});

describe('loadPromoPickerData — варианты (C5)', () => {
  it('возвращает ключ variant из 4-го запроса (product_variants JOIN products)', async () => {
    H.state.variantRows = [{ id: 'v1', name: 'Кресло / Красный' }];
    const result = await loadPromoPickerData();
    expect(result.variant).toEqual([{ id: 'v1', name: 'Кресло / Красный' }]);
  });

  it('остальные ключи присутствуют, форма результата не сломана', async () => {
    const result = await loadPromoPickerData();
    expect(result.category).toEqual([]);
    expect(result.brand).toEqual([]);
    expect(result.product).toEqual([]);
    expect(result.variant).toEqual([]);
  });

  it('запрос вариантов идёт к product_variants с JOIN products и LIMIT 1000', async () => {
    await loadPromoPickerData();
    const texts = H.sqlMock.mock.calls.map((c) =>
      Array.from(c[0] as TemplateStringsArray).join(''),
    );
    const variantQuery = texts.find((t) => t.includes('product_variants'));
    expect(variantQuery).toBeDefined();
    expect(variantQuery).toContain('JOIN products');
    expect(variantQuery).toContain('LIMIT 1000');
  });
});
