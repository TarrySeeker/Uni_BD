/**
 * Утилиты навигации по дереву категорий Storefront API. Дерево приходит с корнем
 * `catalog` (§/categories, docs/21); витрина показывает его детей как верхний
 * уровень и строит по нему хлебные крошки/сайдбар.
 */

import type { CategoryDto } from './types';

/** Верхний уровень каталога: дети корня `catalog`, иначе — сам массив. */
export function topLevelCategories(tree: CategoryDto[]): CategoryDto[] {
  const root = tree.find((c) => c.slug === 'catalog');
  if (root && root.children.length > 0) return root.children;
  return tree;
}

/**
 * Корни дерева категорий (ОБА: `catalog` + `certificates` и т.п.). Именно они —
 * вершина навигации в шапке-меню и в сайдбаре каталога: показываем оба корня и всю
 * вложенность их детей (данные — дерево `/categories`).
 */
export function rootCategories(tree: CategoryDto[]): CategoryDto[] {
  return tree;
}

/**
 * «Разделы для витрин-карточек»: для каждого корня — его дети (если есть), иначе сам
 * корень. Так на главной карточками показываются реальные группы каталога
 * (Твилли/Платки/…), а корень-лист (Подарочные сертификаты) — своей карточкой.
 */
export function browseGroups(tree: CategoryDto[]): CategoryDto[] {
  return tree.flatMap((r) => (r.children.length > 0 ? r.children : [r]));
}

/**
 * Путь от корня дерева до узла со slug (включительно). Пустой массив — не найдено.
 * Напр. slug='twilly-small' → [catalog, twilly, twilly-small].
 */
export function findCategoryPath(
  tree: CategoryDto[],
  slug: string,
): CategoryDto[] {
  for (const node of tree) {
    if (node.slug === slug) return [node];
    const sub = findCategoryPath(node.children, slug);
    if (sub.length > 0) return [node, ...sub];
  }
  return [];
}

/**
 * URL категории — вложенный путь из цепочки предков, как на боевом carrerusse.com
 * (там `thread.url` денормализован через Thread::updateTree: /catalog/platki-i-sharfi/
 * bandani). Корень `catalog` — индекс каталога /catalog, он же префикс для своих
 * потомков; корни вне `catalog` (напр. `certificates`) в путь не попадают.
 * Неизвестный slug → плоский /catalog/{slug} (фолбэк без падения).
 */
export function categoryHref(tree: CategoryDto[], slug: string): string {
  if (slug === 'catalog') return '/catalog';
  const path = findCategoryPath(tree, slug);
  if (path.length === 0) return `/catalog/${slug}`;
  const segments = path
    .map((node) => node.slug)
    .filter((s) => s !== 'catalog');
  return `/catalog/${segments.join('/')}`;
}

/** Узел категории по slug (или null). */
export function findCategory(
  tree: CategoryDto[],
  slug: string,
): CategoryDto | null {
  const path = findCategoryPath(tree, slug);
  return path.length > 0 ? path[path.length - 1] : null;
}

/**
 * Родитель узла со slug (или null для верхнего уровня). Используется, чтобы
 * показать «соседние» категории в сайдбаре, когда открыта категория-лист.
 */
export function findParent(
  tree: CategoryDto[],
  slug: string,
): CategoryDto | null {
  const path = findCategoryPath(tree, slug);
  if (path.length < 2) return null;
  return path[path.length - 2];
}
