import { isDesignerSort } from '@/lib/designers/sort';

/**
 * Адреса раздела «Дизайнеры» с сохранением состояния списка.
 *
 * Поиск и порядок живут в query (?search=…&sort=…), поэтому любой уход из списка и
 * возврат в него обязаны переносить эти параметры — иначе владелец, нашедший
 * дизайнера поиском, после «Отмены» получает список с начала.
 *
 * Функция чистая (строка query → строка href): её зовёт и серверная страница, и
 * клиентская форма (через useSearchParams), не заводя общих данных.
 */
export const DESIGNER_LIST_PATH = '/admin/catalog/designers';

/**
 * Приклеивает к `path` только параметры списка. Всё прочее (utm, чужие redirect,
 * невалидный sort) отбрасывается: белый список, а не перенос query как есть.
 */
export function buildDesignerHref(path: string, query?: string | null): string {
  const incoming = new URLSearchParams(query ?? '');
  const out = new URLSearchParams();

  const search = incoming.get('search')?.trim();
  if (search) out.set('search', search);

  const sort = incoming.get('sort');
  if (isDesignerSort(sort)) out.set('sort', sort);

  const qs = out.toString();
  return qs ? `${path}?${qs}` : path;
}
