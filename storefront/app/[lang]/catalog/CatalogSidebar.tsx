/**
 * Сайдбар каталога — порт группы «Категории» из frontend/views/catalog/list.twig
 * (works-catalog-menu). Рендерит ВСЁ дерево категорий: оба корня (Каталог +
 * Подарочные сертификаты) и всю вложенность подкатегорий, с отступом по глубине и
 * подсветкой активной. i18n: ссылки локализуются через localizedHref (сохраняют
 * локаль); подписи «Категории»/«Все»/«Очистить» — из словаря.
 */

import type { ReactElement } from 'react';
import type { CategoryDto } from '@/lib/types';
import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import type { Dictionary } from '@/lib/dictionaries';

interface Props {
  /** Корни дерева категорий (оба корня со вложенными children). */
  tree: CategoryDto[];
  /** slug активной категории (для подсветки). */
  activeSlug?: string;
  /** Ссылка «Очистить» (сброс к корню каталога) — бесхитростный путь. */
  clearHref: string;
  /** Текущая локаль витрины. */
  locale?: Locale;
  /** Словарь UI-строк. */
  dict?: Dictionary;
}

/** URL категории: корень `catalog` ведёт на индекс /catalog. */
function categoryPath(slug: string): string {
  return slug === 'catalog' ? '/catalog' : `/catalog/${slug}`;
}

/** Рекурсивно разворачивает дерево в плоский список пунктов с отступом по глубине. */
function renderItems(
  nodes: CategoryDto[],
  activeSlug: string | undefined,
  depth: number,
  locale: Locale,
): ReactElement[] {
  const out: ReactElement[] = [];
  for (const node of nodes) {
    const active = node.slug === activeSlug;
    out.push(
      <div
        key={node.slug}
        className={`works-catalog-menu_group--item${active ? ' active' : ''}`}
        style={depth > 0 ? { paddingLeft: depth * 14 } : undefined}
      >
        <a href={localizedHref(categoryPath(node.slug), locale)}>{node.name}</a>
      </div>,
    );
    if (node.children.length > 0) {
      out.push(...renderItems(node.children, activeSlug, depth + 1, locale));
    }
  }
  return out;
}

export default function CatalogSidebar({
  tree,
  activeSlug,
  clearHref,
  locale = DEFAULT_LOCALE,
  dict,
}: Props) {
  const categoriesLabel = dict?.catalog.categories ?? 'Категории';
  const allLabel = dict?.common.all ?? 'Все';
  const clearLabel = dict?.catalog.clear ?? 'Очистить';
  return (
    <div className="works-catalog-menu">
      <div className="works-catalog-menu_group">
        <div className="works-catalog-menu_group--name">{categoriesLabel}</div>
        <div
          className={`works-catalog-menu_group--item${activeSlug ? '' : ' active'}`}
        >
          <a href={localizedHref('/catalog', locale)}>{allLabel}</a>
        </div>
        {renderItems(tree, activeSlug, 0, locale)}
      </div>
      <div className="works-catalog-menu__btns">
        <div>
          <a href={localizedHref(clearHref, locale)} className="link">
            {clearLabel}
          </a>
        </div>
      </div>
    </div>
  );
}
