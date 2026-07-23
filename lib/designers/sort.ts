/**
 * Порядок и поиск в списке дизайнеров (ТЗ владельца п.2: «сортировка по алфавиту
 * от а до я и от я до а» + поиск).
 *
 * ПОЧЕМУ алфавит считается в приложении, а не в SQL. В БД порядок задаёт
 * `ORDER BY sort, name`, где `sort` у всех записей 0, а `name` сравнивается
 * коллацией кластера. Образ стенда — postgres:15-alpine (musl, без ICU-локалей),
 * поэтому сравнение побайтовое: «Ёж» встаёт перед «Егоров», латиница — перед
 * кириллицей. Починить это в SQL можно было бы через `COLLATE "ru-RU-x-icu"`, но на
 * образе без ICU Postgres вернёт ошибку 42704 и раздел «Дизайнеры» упадёт целиком.
 * Intl.Collator в Node доступен всегда (full-icu) и не зависит от образа БД.
 *
 * Чистые функции: ни БД, ни Next — тестируются напрямую. Локаль приходит аргументом
 * (настройка магазина), хардкода языка здесь нет.
 */

/** Допустимые порядки списка. Всё, что вне списка, схлопывается в дефолт. */
export const DESIGNER_SORTS = ['manual', 'name_asc', 'name_desc'] as const;

export type DesignerSort = (typeof DESIGNER_SORTS)[number];

/** Дефолт домена: ручной порядок (`sort, name` из БД) — обратная совместимость. */
export const DEFAULT_DESIGNER_SORT: DesignerSort = 'manual';

/** Дефолт админского списка: алфавит А-Я (владелец ждёт алфавит «из коробки»). */
export const ADMIN_DEFAULT_DESIGNER_SORT: DesignerSort = 'name_asc';

/** Нормализованные параметры списка дизайнеров. */
export interface DesignerListParams {
  search?: string;
  sort: DesignerSort;
}

export function isDesignerSort(value: unknown): value is DesignerSort {
  return typeof value === 'string' && (DESIGNER_SORTS as readonly string[]).includes(value);
}

/**
 * Нормализует query-параметры списка (образец parseAuditFilters):
 *   * sort — только значение из DESIGNER_SORTS, иначе дефолт вызывающего;
 *   * search — trim, пустой → undefined;
 *   * повторённый параметр (?sort=a&sort=b) → берётся первый.
 */
export function parseDesignerListParams(
  sp: Record<string, string | string[] | undefined>,
  opts: { defaultSort?: DesignerSort } = {},
): DesignerListParams {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const sort = one('sort');
  const search = one('search')?.trim();

  return {
    search: search || undefined,
    sort: isDesignerSort(sort) ? sort : (opts.defaultSort ?? DEFAULT_DESIGNER_SORT),
  };
}

// Коллаторы кэшируются по локали: создание Intl.Collator дорогое, а в цикле
// сравнения оно недопустимо (O(n log n) конструкций вместо одной).
const COLLATOR_OPTIONS: Intl.CollatorOptions = { usage: 'sort', numeric: true };
const collators = new Map<string, Intl.Collator>();

function collatorFor(locale?: string): Intl.Collator {
  const key = (locale ?? '').trim().toLowerCase();
  const cached = collators.get(key);
  if (cached) return cached;

  let collator: Intl.Collator;
  try {
    // Пустой ключ → системный дефолт; кривой тег ('ru_RU') бросает RangeError.
    collator = new Intl.Collator(key || undefined, COLLATOR_OPTIONS);
  } catch {
    collator = new Intl.Collator(undefined, COLLATOR_OPTIONS);
  }
  collators.set(key, collator);
  return collator;
}

/** Минимум, нужный для алфавита: работает и с Designer, и с любым { name }. */
interface HasName {
  name: string;
}

/**
 * Алфавитный порядок по имени. Записи с пустым именем всегда уходят в хвост (и в
 * А-Я, и в Я-А), чтобы список не начинался с безымянной строки. Возвращает НОВЫЙ
 * массив; вход не мутируется.
 */
export function sortDesignersByName<T extends HasName>(
  list: readonly T[],
  direction: 'asc' | 'desc',
  locale?: string,
): T[] {
  const collator = collatorFor(locale);
  const sign = direction === 'desc' ? -1 : 1;

  const named: T[] = [];
  const blank: T[] = [];
  for (const item of list) {
    (typeof item.name === 'string' && item.name.trim() ? named : blank).push(item);
  }

  named.sort((a, b) => sign * collator.compare(a.name, b.name));
  return named.concat(blank);
}

/**
 * Применяет выбранный порядок. Для 'manual' (и отсутствующего значения) возвращает
 * ТОТ ЖЕ массив — порядок из БД (`ORDER BY sort, name`) остаётся нетронутым; на этом
 * держится совместимость публичного Storefront API и селектов формы товара.
 */
export function applyDesignerSort<T extends HasName>(
  list: T[],
  sort: DesignerSort | undefined,
  locale?: string,
): T[] {
  if (sort === 'name_asc') return sortDesignersByName(list, 'asc', locale);
  if (sort === 'name_desc') return sortDesignersByName(list, 'desc', locale);
  return list;
}
