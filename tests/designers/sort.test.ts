import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DESIGNER_SORTS,
  DEFAULT_DESIGNER_SORT,
  ADMIN_DEFAULT_DESIGNER_SORT,
  applyDesignerSort,
  isDesignerSort,
  parseDesignerListParams,
  sortDesignersByName,
} from '../../lib/designers/sort';

// ЮНИТ: сортировка и поиск дизайнеров (ТЗ владельца п.2 — «от а до я и от я до а» + поиск).
//
// ДЕФЕКТ: lib/designers/repository.ts отдавал ORDER BY sort, name, где sort у всех
// записей = 0 (поле не выведено в форму), а name сортировался коллацией БД. Образ
// стенда — postgres:15-alpine (musl, без ICU-локалей), COLLATE в репозитории нет →
// побайтовый порядок: «Ёж» перед «Егоров», латиница перед кириллицей.
//
// РЕШЕНИЕ: алфавит считаем В ПРИЛОЖЕНИИ через Intl.Collator (ICU в Node есть всегда),
// а НЕ через ORDER BY ... COLLATE "ru-RU-x-icu" — такой COLLATE на образе без ICU
// уронил бы весь раздел ошибкой 42704.

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const D = (name: string) => ({ name });
const names = (list: { name: string }[]) => list.map((d) => d.name);

describe('DESIGNER_SORTS — белый список порядков', () => {
  it('ровно три значения: ручной, А-Я, Я-А', () => {
    expect(DESIGNER_SORTS).toEqual(['manual', 'name_asc', 'name_desc']);
  });

  it('дефолт домена — manual (совместимость), дефолт админки — name_asc', () => {
    expect(DEFAULT_DESIGNER_SORT).toBe('manual');
    expect(ADMIN_DEFAULT_DESIGNER_SORT).toBe('name_asc');
  });

  it('isDesignerSort пропускает только значения из списка', () => {
    expect(isDesignerSort('name_asc')).toBe(true);
    expect(isDesignerSort('name_desc')).toBe(true);
    expect(isDesignerSort('manual')).toBe(true);
    expect(isDesignerSort('name')).toBe(false);
    expect(isDesignerSort('')).toBe(false);
    expect(isDesignerSort(undefined)).toBe(false);
    expect(isDesignerSort('name_asc; DROP TABLE designers')).toBe(false);
  });
});

describe('parseDesignerListParams — нормализация query-параметров', () => {
  it('пустые searchParams → дефолт домена, поиска нет', () => {
    expect(parseDesignerListParams({})).toEqual({ search: undefined, sort: 'manual' });
  });

  it('дефолт переопределяется вызывающим (админка просит А-Я)', () => {
    expect(parseDesignerListParams({}, { defaultSort: 'name_asc' })).toEqual({
      search: undefined,
      sort: 'name_asc',
    });
  });

  it('валидный sort принимается, мусорный — отбрасывается в дефолт', () => {
    expect(parseDesignerListParams({ sort: 'name_desc' }).sort).toBe('name_desc');
    expect(parseDesignerListParams({ sort: 'name COLLATE "ru-RU-x-icu"' }).sort).toBe('manual');
    expect(
      parseDesignerListParams({ sort: 'zzz' }, { defaultSort: 'name_asc' }).sort,
    ).toBe('name_asc');
  });

  it('повторённый параметр (?sort=a&sort=b) → берётся первый', () => {
    expect(parseDesignerListParams({ sort: ['name_desc', 'name_asc'] }).sort).toBe('name_desc');
    expect(parseDesignerListParams({ search: ['Иван', 'Пётр'] }).search).toBe('Иван');
  });

  it('search триммится; пустой/из пробелов → undefined', () => {
    expect(parseDesignerListParams({ search: '  Иван  ' }).search).toBe('Иван');
    expect(parseDesignerListParams({ search: '' }).search).toBeUndefined();
    expect(parseDesignerListParams({ search: '   ' }).search).toBeUndefined();
  });
});

describe('sortDesignersByName — алфавит через Intl.Collator', () => {
  it('А-Я: кириллица по алфавиту', () => {
    const list = [D('Яна'), D('Борис'), D('Анна'), D('Владимир')];
    expect(names(sortDesignersByName(list, 'asc', 'ru'))).toEqual([
      'Анна', 'Борис', 'Владимир', 'Яна',
    ]);
  });

  it('Я-А: строго обратный порядок к А-Я', () => {
    const list = [D('Яна'), D('Борис'), D('Анна'), D('Владимир')];
    const asc = names(sortDesignersByName(list, 'asc', 'ru'));
    const desc = names(sortDesignersByName(list, 'desc', 'ru'));
    expect(desc).toEqual([...asc].reverse());
  });

  it('Ё не выпадает из алфавита: «Егоров» < «Ёж», «Елка» < «Ёлка»', () => {
    const list = [D('Ёж'), D('Ёлка'), D('Егоров'), D('Елка')];
    expect(names(sortDesignersByName(list, 'asc', 'ru'))).toEqual([
      'Егоров', 'Ёж', 'Елка', 'Ёлка',
    ]);
  });

  it('регистр не разрывает группу: «анна» и «Анна» рядом, до «Борис»', () => {
    const list = [D('Борис'), D('анна'), D('Анна')];
    const sorted = names(sortDesignersByName(list, 'asc', 'ru'));
    expect(sorted[2]).toBe('Борис');
    expect(sorted.slice(0, 2).sort()).toEqual(['Анна', 'анна'].sort());
  });

  it('латиница и кириллица вперемешку: в ru-локали кириллица идёт первой', () => {
    const list = [D('Zara'), D('Яна'), D('Adidas'), D('Анна')];
    expect(names(sortDesignersByName(list, 'asc', 'ru'))).toEqual([
      'Анна', 'Яна', 'Adidas', 'Zara',
    ]);
  });

  it('числа в именах сравниваются как числа: «Студия 2» < «Студия 10»', () => {
    const list = [D('Студия 10'), D('Студия 2')];
    expect(names(sortDesignersByName(list, 'asc', 'ru'))).toEqual(['Студия 2', 'Студия 10']);
  });

  it('пустые имена всегда в хвосте — и в А-Я, и в Я-А', () => {
    const list = [D(''), D('Борис'), D('   '), D('Анна')];
    expect(names(sortDesignersByName(list, 'asc', 'ru')).slice(0, 2)).toEqual(['Анна', 'Борис']);
    expect(names(sortDesignersByName(list, 'desc', 'ru')).slice(0, 2)).toEqual(['Борис', 'Анна']);
    expect(names(sortDesignersByName(list, 'desc', 'ru')).slice(2).join('').trim()).toBe('');
  });

  it('не мутирует входной массив', () => {
    const list = [D('Яна'), D('Анна')];
    const before = names(list);
    sortDesignersByName(list, 'asc', 'ru');
    expect(names(list)).toEqual(before);
  });

  it('локаль берётся аргументом (мультитенантность), не хардкодом', () => {
    const list = [D('Zebra'), D('Ärger'), D('Apfel')];
    // В шведской локали Ä — отдельная буква В КОНЦЕ алфавита, в немецкой — рядом с A.
    expect(names(sortDesignersByName(list, 'asc', 'sv'))).toEqual(['Apfel', 'Zebra', 'Ärger']);
    expect(names(sortDesignersByName(list, 'asc', 'de'))).toEqual(['Apfel', 'Ärger', 'Zebra']);
  });

  it('битая/пустая локаль не роняет сортировку (fail-safe фолбэк)', () => {
    const list = [D('Яна'), D('Анна')];
    expect(() => sortDesignersByName(list, 'asc', '')).not.toThrow();
    expect(() => sortDesignersByName(list, 'asc', 'ru_RU')).not.toThrow();
    expect(() => sortDesignersByName(list, 'asc', undefined)).not.toThrow();
    expect(names(sortDesignersByName(list, 'asc', 'ru_RU'))).toEqual(['Анна', 'Яна']);
  });
});

describe('applyDesignerSort — инвариант «manual ничего не трогает»', () => {
  it('manual возвращает ТОТ ЖЕ массив (порядок БД сохраняется байт-в-байт)', () => {
    const list = [D('Яна'), D('Анна')];
    expect(applyDesignerSort(list, 'manual', 'ru')).toBe(list);
  });

  it('undefined-сортировка эквивалентна manual', () => {
    const list = [D('Яна'), D('Анна')];
    expect(applyDesignerSort(list, undefined, 'ru')).toBe(list);
  });

  it('name_asc / name_desc делегируют в sortDesignersByName', () => {
    const list = [D('Яна'), D('Анна')];
    expect(names(applyDesignerSort(list, 'name_asc', 'ru'))).toEqual(['Анна', 'Яна']);
    expect(names(applyDesignerSort(list, 'name_desc', 'ru'))).toEqual(['Яна', 'Анна']);
  });
});

// ---------------------------------------------------------------------------
// Guard-тесты по исходникам: БД в юнит-окружении нет, а инвариант «listDesigners()
// без аргументов работает как раньше» и запрет COLLATE проверяются текстом.
// ---------------------------------------------------------------------------

describe('lib/designers/repository.ts — поиск и совместимость', () => {
  const src = () => read('lib/designers/repository.ts');

  it('порядок из БД остался ORDER BY sort, name — никакого COLLATE', () => {
    expect(src()).toMatch(/ORDER BY sort, name/);
    expect(src()).not.toMatch(/COLLATE/i);
    expect(src()).not.toMatch(/x-icu/);
  });

  it('поиск параметризован и экранирован (escapeLike), склейки строк в SQL нет', () => {
    const s = src();
    expect(s).toContain("import { escapeLike } from '@/lib/db/like'");
    expect(s).toMatch(/escapeLike\(/);
    expect(s).toMatch(/searchTerm\}::text IS NULL/);
    expect(s).toMatch(/name ILIKE \$\{searchTerm\}/);
  });

  it('без search условие поиска нейтрально: searchTerm = null', () => {
    expect(src()).toMatch(/searchTerm\s*=\s*[^;]*\?\s*`%\$\{escapeLike\([^)]*\)\}%`\s*:\s*null/);
  });

  it('алфавит применяется в приложении через applyDesignerSort', () => {
    const s = src();
    expect(s).toContain("from './sort'");
    expect(s).toMatch(/applyDesignerSort\(/);
  });
});

describe('app/admin/(panel)/catalog/designers/page.tsx — UI поиска и порядка', () => {
  const src = () => read('app/admin/(panel)/catalog/designers/page.tsx');

  it('дефолт админки — А-Я (ADMIN_DEFAULT_DESIGNER_SORT)', () => {
    expect(src()).toContain('ADMIN_DEFAULT_DESIGNER_SORT');
  });

  it('GET-форма с полем поиска и переключателем порядка', () => {
    const s = src();
    expect(s).toMatch(/<form[^>]*method="get"/);
    expect(s).toMatch(/name="search"/);
    expect(s).toMatch(/name="sort"/);
    expect(s).toContain('value="name_asc"');
    expect(s).toContain('value="name_desc"');
    expect(s).toContain('value="manual"');
  });

  it('параметры читаются из searchParams общим парсером', () => {
    const s = src();
    expect(s).toContain('searchParams');
    expect(s).toContain('parseDesignerListParams');
  });

  it('локаль коллатора — из настроек магазина, без хардкода', () => {
    const s = src();
    expect(s).toContain('getLocaleConfig');
    expect(s).not.toMatch(/['"]ru['"]/);
  });
});
