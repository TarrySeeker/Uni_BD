import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRODUCT_LIST_PAGE_SIZE,
  buildProductListQuery,
  buildProductListResetQuery,
  parseProductListFilter,
} from '../../lib/catalog/list-filters';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const FILTERS_TSX = 'app/admin/(panel)/catalog/_components/ProductFilters.tsx';
const PAGE_TSX = 'app/admin/(panel)/catalog/page.tsx';

const UUID_A = '9f8c1a2b-3d4e-4f5a-9b6c-7d8e9f0a1b2c';
const UUID_B = '11111111-1111-4111-8111-111111111111';
const UUID_C = '22222222-2222-4222-8222-222222222222';

describe('parseProductListFilter — базовая нормализация', () => {
  it('пустой query → дефолты (первая страница, сортировка created_desc)', () => {
    const f = parseProductListFilter({});
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(PRODUCT_LIST_PAGE_SIZE);
    expect(f.sort).toBe('created_desc');
    expect(f.search).toBeUndefined();
    expect(f.status).toBeUndefined();
    expect(f.brandId).toBeUndefined();
    expect(f.designerId).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
    expect(f.isFeatured).toBeUndefined();
    expect(f.isNew).toBeUndefined();
    expect(f.onSale).toBeUndefined();
  });

  it('берёт первый элемент массива и режет мусорные status/sort/page', () => {
    const f = parseProductListFilter({
      search: ['халат', 'лишнее'],
      status: 'nope',
      sort: 'random',
      page: '-3',
    });
    expect(f.search).toBe('халат');
    expect(f.status).toBeUndefined();
    expect(f.sort).toBe('created_desc');
    expect(f.page).toBe(1);
  });

  it('валидные status/sort/page/флаги проходят', () => {
    const f = parseProductListFilter({
      status: 'active',
      sort: 'price_asc',
      page: '4',
      isFeatured: '1',
      isNew: '1',
      onSale: '1',
    });
    expect(f.status).toBe('active');
    expect(f.sort).toBe('price_asc');
    expect(f.page).toBe(4);
    expect(f.isFeatured).toBe(true);
    expect(f.isNew).toBe(true);
    expect(f.onSale).toBe(true);
  });
});

describe('parseProductListFilter — UUID-параметры (защита от 22P02 / 500)', () => {
  it('designerId: валидный uuid попадает в фильтр', () => {
    expect(parseProductListFilter({ designerId: UUID_A }).designerId).toBe(UUID_A);
  });

  // ГЛАВНОЕ: значение уходит в ::uuid-каст (lib/catalog/repository.ts), поэтому
  // ?designerId=abc без валидации даёт postgres 22P02 → 500 на странице админки.
  it.each(['abc', 'not-a-uuid', '9f8c1a2b-3d4e-4f5a-9b6c', "' OR 1=1 --", ' '])(
    'designerId: мусор %j отбрасывается (фильтр не применяется)',
    (bad) => {
      expect(parseProductListFilter({ designerId: bad }).designerId).toBeUndefined();
    },
  );

  // brandId-контрол убран из UI, но парсинг оставлен: сохранённые ссылки должны работать.
  it('brandId: парсинг СОХРАНЁН для старых ссылок', () => {
    expect(parseProductListFilter({ brandId: UUID_B }).brandId).toBe(UUID_B);
  });

  it('brandId: мусор отбрасывается (та же дыра с ::uuid)', () => {
    expect(parseProductListFilter({ brandId: 'abc' }).brandId).toBeUndefined();
  });

  it('categoryId: валидный uuid проходит, мусор отбрасывается', () => {
    expect(parseProductListFilter({ categoryId: UUID_C }).categoryId).toBe(UUID_C);
    expect(parseProductListFilter({ categoryId: 'abc' }).categoryId).toBeUndefined();
  });

  it('пустые строки id трактуются как отсутствие фильтра', () => {
    const f = parseProductListFilter({ brandId: '', designerId: '', categoryId: '' });
    expect(f.brandId).toBeUndefined();
    expect(f.designerId).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
  });

  it('id обрезаются от пробелов', () => {
    expect(parseProductListFilter({ designerId: ` ${UUID_A} ` }).designerId).toBe(UUID_A);
  });
});

// Вёрстку React-компонентов в этом репо не рендерят (vitest environment 'node',
// без jsdom/@testing-library), поэтому UI-контракт проверяем по исходнику.
describe('ProductFilters — контрол «Бренд» заменён на «Дизайнер» (ТЗ п.3)', () => {
  it('селекта бренда больше нет', () => {
    const src = read(FILTERS_TSX);
    expect(src).not.toContain('f-brand');
    expect(src).not.toContain('brands.map');
    expect(src).not.toContain('setBrandId');
    expect(src).not.toContain("next.set('brandId'");
    expect(src).not.toMatch(/brands\s*[,:]/);
  });

  it('есть селект дизайнера с меткой «Дизайнер» и пустым «Любой»', () => {
    const src = read(FILTERS_TSX);
    expect(src).toContain('f-designer');
    expect(src).toContain('Дизайнер');
    expect(src).toMatch(/designers\.map/);
    expect(src).toMatch(/designerId/);
  });

  it('designerId участвует в querystring и в сбросе фильтров', () => {
    const src = read(FILTERS_TSX);
    const submit = src.slice(src.indexOf('function submit('), src.indexOf('function reset('));
    expect(submit).toContain('buildProductListQuery');
    expect(submit).toMatch(/designerId,/);
    const reset = src.slice(src.indexOf('function reset('));
    expect(reset).toContain("setDesignerId('')");
  });

  // Регресс: submit() собирал querystring с нуля из локального стейта, поэтому
  // «Применить» стирал из URL параметры без контрола (brandId, sort).
  it('querystring собирается чистой функцией, а не URLSearchParams вручную', () => {
    const src = read(FILTERS_TSX);
    expect(src).toContain("from '@/lib/catalog/list-filters'");
    expect(src).toContain('buildProductListQuery');
    expect(src).toContain('buildProductListResetQuery');
    expect(src).not.toContain('new URLSearchParams(');
    expect(src).not.toMatch(/next\.set\(/);
  });
});

describe('buildProductListQuery — сквозные параметры переживают «Применить»', () => {
  const EMPTY = {
    search: '',
    status: '',
    designerId: '',
    categoryId: '',
    isFeatured: false,
    isNew: false,
    onSale: false,
  };
  const qs = (s: string) => new URLSearchParams(s);

  it('пустая форма и пустой URL → пустая строка', () => {
    expect(buildProductListQuery(qs(''), EMPTY)).toBe('');
  });

  it('пишет только заполненные поля формы', () => {
    const out = qs(buildProductListQuery(qs(''), { ...EMPTY, search: '  халат  ', status: 'active' }));
    expect(out.get('search')).toBe('халат');
    expect(out.get('status')).toBe('active');
    expect(out.has('designerId')).toBe(false);
    expect(out.has('isNew')).toBe(false);
  });

  it('флаги пишутся как 1', () => {
    const out = qs(buildProductListQuery(qs(''), { ...EMPTY, isFeatured: true, isNew: true, onSale: true }));
    expect(out.get('isFeatured')).toBe('1');
    expect(out.get('isNew')).toBe('1');
    expect(out.get('onSale')).toBe('1');
  });

  // ГЛАВНОЕ: контрола «Бренд» в панели нет (ТЗ п.3), но ссылка из раздела
  // «Бренды» обязана пережить клик «Применить».
  it('brandId из текущего URL сохраняется при применении фильтров', () => {
    const out = qs(buildProductListQuery(qs(`brandId=${UUID_B}`), EMPTY));
    expect(out.get('brandId')).toBe(UUID_B);
  });

  it('brandId сохраняется вместе с остальными фильтрами', () => {
    const out = qs(
      buildProductListQuery(qs(`brandId=${UUID_B}&page=7`), {
        ...EMPTY,
        search: 'платок',
        status: 'active',
        designerId: UUID_A,
        categoryId: UUID_C,
        onSale: true,
      }),
    );
    expect(out.get('brandId')).toBe(UUID_B);
    expect(out.get('search')).toBe('платок');
    expect(out.get('status')).toBe('active');
    expect(out.get('designerId')).toBe(UUID_A);
    expect(out.get('categoryId')).toBe(UUID_C);
    expect(out.get('onSale')).toBe('1');
  });

  it('sort (тоже без контрола в панели) сохраняется', () => {
    const out = qs(buildProductListQuery(qs('sort=price_asc'), { ...EMPTY, status: 'draft' }));
    expect(out.get('sort')).toBe('price_asc');
  });

  it('page сбрасывается на первую страницу при смене фильтров', () => {
    const out = qs(buildProductListQuery(qs(`page=5&brandId=${UUID_B}`), { ...EMPTY, isNew: true }));
    expect(out.has('page')).toBe(false);
    expect(out.get('brandId')).toBe(UUID_B);
  });

  it('чужие/неизвестные параметры URL не тянутся дальше', () => {
    const out = qs(buildProductListQuery(qs('utm_source=mail&foo=bar'), EMPTY));
    expect(out.has('utm_source')).toBe(false);
    expect(out.has('foo')).toBe(false);
  });

  it('пустые сквозные параметры не попадают в querystring', () => {
    expect(buildProductListQuery(qs('brandId=&sort='), EMPTY)).toBe('');
  });

  // Решение: «Сбросить» = снять ВСЕ фильтры, включая невидимый brandId — иначе
  // список остаётся сужённым при пустых контролах и объяснить это нечем.
  // Порядок сортировки — не фильтр, его сброс не трогает.
  it('«Сбросить» снимает brandId вместе с остальными фильтрами', () => {
    const out = qs(buildProductListResetQuery(qs(`brandId=${UUID_B}&search=x&page=4`)));
    expect(out.has('brandId')).toBe(false);
    expect(out.has('search')).toBe(false);
    expect(out.has('page')).toBe(false);
  });

  it('«Сбросить» сохраняет выбранный порядок сортировки', () => {
    expect(buildProductListResetQuery(qs('sort=name_asc&brandId=' + UUID_B))).toBe(
      'sort=name_asc',
    );
  });

  it('«Сбросить» без сортировки в URL → пустая строка', () => {
    expect(buildProductListResetQuery(qs(`brandId=${UUID_B}`))).toBe('');
  });
});

describe('Страница каталога — источник данных и парсинг фильтра', () => {
  it('грузит дизайнеров вместо брендов и отдаёт их в ProductFilters', () => {
    const src = read(PAGE_TSX);
    expect(src).toContain('listDesigners');
    expect(src).toContain('designers={designers}');
    expect(src).not.toContain('listBrands');
    expect(src).not.toContain('brands={brands}');
  });

  it('фильтр парсится общим чистым модулем, локальной parseFilter нет', () => {
    const src = read(PAGE_TSX);
    expect(src).toContain('parseProductListFilter');
    expect(src).toContain('@/lib/catalog/list-filters');
    expect(src).not.toMatch(/function parseFilter\(/);
  });
});
