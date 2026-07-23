/**
 * Разбор query-параметров списка товаров админки (docs/05 §5.2).
 *
 * Вынесено из app/admin/(panel)/catalog/page.tsx в чистый модуль (по образцу
 * lib/admin/audit-filters.ts): состояние фильтров живёт в URL, значит его
 * нормализация — тестируемая функция без Next/БД.
 *
 * Почему валидируем uuid: brandId/designerId/categoryId уходят в ::uuid-каст
 * (lib/catalog/repository.ts — WHERE и categorySubtreeIds). Любая непарсящаяся
 * строка из адресной строки (?designerId=abc) роняет запрос ошибкой postgres
 * 22P02 и превращает страницу админки в 500. Невалидное значение трактуем как
 * «фильтр не задан» — так же, как публичный API отвергает его 400-м.
 *
 * Мультитенантно: никаких магазинных допущений, только словари платформы.
 */

import { z } from 'zod';

import { PRODUCT_STATUSES, type ProductStatus } from './types';
import type { ProductListFilter, ProductSort } from './repository';

/** Размер страницы списка товаров в админке. */
export const PRODUCT_LIST_PAGE_SIZE = 25;

const PRODUCT_SORTS: ProductSort[] = [
  'created_desc',
  'name_asc',
  'price_asc',
  'price_desc',
];

const uuidParam = z.string().uuid();

/** Значение для ::uuid-параметра: валидный uuid или undefined (фильтр off). */
function uuidOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return uuidParam.safeParse(trimmed).success ? trimmed : undefined;
}

/**
 * searchParams → строго типизированный фильтр listProducts.
 *
 * brandId разбирается, хотя контрол «Бренд» убран из панели фильтров (ТЗ п.3):
 * репозиторий фасет поддерживает, и сохранённые ссылки вида ?brandId=… должны
 * продолжать работать.
 */
export function parseProductListFilter(
  sp: Record<string, string | string[] | undefined>,
  pageSize: number = PRODUCT_LIST_PAGE_SIZE,
): ProductListFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const status = one('status');
  const sort = one('sort');
  const page = Number(one('page') ?? '1');

  return {
    search: one('search') || undefined,
    status: PRODUCT_STATUSES.includes(status as ProductStatus)
      ? (status as ProductStatus)
      : undefined,
    brandId: uuidOrUndefined(one('brandId')),
    designerId: uuidOrUndefined(one('designerId')),
    categoryId: uuidOrUndefined(one('categoryId')),
    isFeatured: one('isFeatured') === '1' ? true : undefined,
    isNew: one('isNew') === '1' ? true : undefined,
    onSale: one('onSale') === '1' ? true : undefined,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize,
    sort: PRODUCT_SORTS.includes(sort as ProductSort)
      ? (sort as ProductSort)
      : 'created_desc',
  };
}

/** Состояние контролов панели фильтров (app/admin/(panel)/catalog/_components/ProductFilters.tsx). */
export type ProductListFormState = {
  search: string;
  status: string;
  designerId: string;
  categoryId: string;
  isFeatured: boolean;
  isNew: boolean;
  onSale: boolean;
};

/**
 * Параметры URL, влияющие на выдачу, но не имеющие контрола в панели:
 * brandId (фасет убран из UI по ТЗ п.3, ссылки из раздела «Бренды» живы) и
 * sort. Без переноса их стирал бы первый же клик «Применить».
 */
const PASSTHROUGH_ON_APPLY = ['brandId', 'sort'] as const;

/** «Сбросить» снимает все фильтры (в т.ч. невидимый brandId), но не порядок сортировки. */
const PASSTHROUGH_ON_RESET = ['sort'] as const;

function carryOver(
  current: URLSearchParams,
  next: URLSearchParams,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = current.get(key)?.trim();
    if (value) next.set(key, value);
  }
}

/**
 * Новый querystring списка товаров: значения контролов панели + сквозные
 * параметры текущего URL. page намеренно не переносится — смена фильтров
 * возвращает на первую страницу.
 */
export function buildProductListQuery(
  current: URLSearchParams,
  form: ProductListFormState,
): string {
  const next = new URLSearchParams();
  const search = form.search.trim();
  if (search) next.set('search', search);
  if (form.status) next.set('status', form.status);
  if (form.designerId) next.set('designerId', form.designerId);
  if (form.categoryId) next.set('categoryId', form.categoryId);
  if (form.isFeatured) next.set('isFeatured', '1');
  if (form.isNew) next.set('isNew', '1');
  if (form.onSale) next.set('onSale', '1');
  carryOver(current, next, PASSTHROUGH_ON_APPLY);
  return next.toString();
}

/** Querystring после кнопки «Сбросить». */
export function buildProductListResetQuery(current: URLSearchParams): string {
  const next = new URLSearchParams();
  carryOver(current, next, PASSTHROUGH_ON_RESET);
  return next.toString();
}
