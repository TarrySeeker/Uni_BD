/**
 * Сайдбар каталога — порт группы «Категории» из frontend/views/catalog/list.twig
 * (works-catalog-menu). Теперь рендерит ВСЁ дерево категорий: оба корня
 * (Каталог + Подарочные сертификаты) и всю вложенность подкатегорий, с отступом по
 * глубине и подсветкой активной. Фильтры материал/цвет/дизайнер опущены (данные
 * carre их не содержат; Storefront API фильтрует только по category, docs/21 §1).
 */

import type { ReactElement } from 'react';
import type { CategoryDto } from '@/lib/types';

interface Props {
  /** Корни дерева категорий (оба корня со вложенными children). */
  tree: CategoryDto[];
  /** slug активной категории (для подсветки). */
  activeSlug?: string;
  /** Ссылка «Очистить» (сброс к корню каталога). */
  clearHref: string;
}

/** URL категории: корень `catalog` ведёт на индекс /catalog. */
function categoryHref(slug: string): string {
  return slug === 'catalog' ? '/catalog' : `/catalog/${slug}`;
}

/** Рекурсивно разворачивает дерево в плоский список пунктов с отступом по глубине. */
function renderItems(
  nodes: CategoryDto[],
  activeSlug: string | undefined,
  depth: number,
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
        <a href={categoryHref(node.slug)}>{node.name}</a>
      </div>,
    );
    if (node.children.length > 0) {
      out.push(...renderItems(node.children, activeSlug, depth + 1));
    }
  }
  return out;
}

export default function CatalogSidebar({ tree, activeSlug, clearHref }: Props) {
  return (
    <div className="works-catalog-menu">
      <div className="works-catalog-menu_group">
        <div className="works-catalog-menu_group--name">Категории</div>
        <div
          className={`works-catalog-menu_group--item${activeSlug ? '' : ' active'}`}
        >
          <a href="/catalog">Все</a>
        </div>
        {renderItems(tree, activeSlug, 0)}
      </div>
      <div className="works-catalog-menu__btns">
        <div>
          <a href={clearHref} className="link">
            Очистить
          </a>
        </div>
      </div>
    </div>
  );
}
