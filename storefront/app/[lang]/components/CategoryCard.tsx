/**
 * Карточка категории — порт frontend/views/misc_blocks/__category-card.twig:
 *   a.category > div.category__image[background-image] + span.category__name
 * Фото берётся из /categories (CategoryDto.imageUrl, резолвится админкой из
 * image_key). Классы .category/.category__image/.category__name — в storefront.css.
 * i18n: ссылка локализуется через localizedHref (сохраняет текущую локаль).
 */

import type { CategoryDto } from '@/lib/types';
import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

/** URL категории: корень `catalog` ведёт на индекс /catalog, остальные — на slug. */
function categoryPath(slug: string): string {
  return slug === 'catalog' ? '/catalog' : `/catalog/${slug}`;
}

export default function CategoryCard({
  category,
  locale = DEFAULT_LOCALE,
}: {
  category: CategoryDto;
  locale?: Locale;
}) {
  return (
    <a href={localizedHref(categoryPath(category.slug), locale)} className="category">
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
