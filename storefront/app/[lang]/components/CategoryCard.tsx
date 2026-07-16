/**
 * Карточка категории — порт frontend/views/misc_blocks/__category-card.twig:
 *   a.category > div.category__image[background-image] + span.category__name
 * Фото берётся из /categories (CategoryDto.imageUrl, резолвится админкой из
 * image_key). Классы .category/.category__image/.category__name — в storefront.css.
 */

import type { CategoryDto } from '@/lib/types';

/** URL категории: корень `catalog` ведёт на индекс /catalog, остальные — на slug. */
function categoryHref(slug: string): string {
  return slug === 'catalog' ? '/catalog' : `/catalog/${slug}`;
}

export default function CategoryCard({ category }: { category: CategoryDto }) {
  return (
    <a href={categoryHref(category.slug)} className="category">
      <div
        className="category__image"
        style={
          category.imageUrl
            ? { backgroundImage: `url('${category.imageUrl}')` }
            : undefined
        }
      />
      <span className="category__name">{category.name}</span>
    </a>
  );
}
