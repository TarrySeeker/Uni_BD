/**
 * Пагинация каталога — порт frontend/views/misc_blocks/pagination.twig
 * (.pagination / .pagination-list / .pagination__page(--active) + «Показать еще»).
 * Страницы — через query `?page=N` (N ≥ 1); page=1 отдаётся без параметра.
 * Активная сортировка (`sort`) СОХРАНЯЕТСЯ во всех ссылках пагинации — иначе смена
 * страницы молча сбрасывала бы порядок к дефолту (created_at DESC).
 * i18n: basePath (`/catalog/...`) локализуется через localizedHref; подпись «Показать
 * еще» — из словаря.
 */

import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

interface Props {
  /** Текущая страница, 1-based. */
  page: number;
  /** Всего страниц. */
  pageCount: number;
  /** Базовый путь без query, напр. `/catalog/twilly` (бесхитростный, без локали). */
  basePath: string;
  /** Активная сортировка (carre: asc/desc); переносится в ссылки страниц. */
  sort?: string;
  /** Текущая локаль — навешивается на basePath. */
  locale?: Locale;
  /** Подпись «Показать еще» из словаря. */
  moreLabel?: string;
}

function pageHref(
  basePath: string,
  n: number,
  locale: Locale,
  sort?: string,
): string {
  const params = new URLSearchParams();
  if (n > 1) params.set('page', String(n));
  if (sort) params.set('sort', sort);
  const qs = params.toString();
  const path = qs ? `${basePath}?${qs}` : basePath;
  return localizedHref(path, locale);
}

export default function Pagination({
  page,
  pageCount,
  basePath,
  sort,
  locale = DEFAULT_LOCALE,
  moreLabel = 'Показать еще',
}: Props) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return (
    <div className="pagination">
      <div className="pagination__nav">
        <div className="pagination-list">
          {pages.map((n) => (
            <a
              key={n}
              href={pageHref(basePath, n, locale, sort)}
              className={`pagination__page${
                n === page ? ' pagination__page--active' : ''
              }`}
            >
              {n}
            </a>
          ))}
        </div>
      </div>
      <div className="pagination__nav--more">
        {page < pageCount && (
          <a
            href={pageHref(basePath, page + 1, locale, sort)}
            className="js-catalog-page js-catalog-page--more"
          >
            {moreLabel}
          </a>
        )}
      </div>
    </div>
  );
}
