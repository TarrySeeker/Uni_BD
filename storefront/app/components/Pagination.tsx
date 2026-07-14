/**
 * Пагинация каталога — порт frontend/views/misc_blocks/pagination.twig
 * (.pagination / .pagination-list / .pagination__page(--active) + «Показать еще»).
 * Страницы — через query `?page=N` (N ≥ 1); page=1 отдаётся без параметра.
 */

interface Props {
  /** Текущая страница, 1-based. */
  page: number;
  /** Всего страниц. */
  pageCount: number;
  /** Базовый путь без query, напр. `/catalog/twilly`. */
  basePath: string;
}

function pageHref(basePath: string, n: number): string {
  return n <= 1 ? basePath : `${basePath}?page=${n}`;
}

export default function Pagination({ page, pageCount, basePath }: Props) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return (
    <div className="pagination">
      <div className="pagination__nav">
        <div className="pagination-list">
          {pages.map((n) => (
            <a
              key={n}
              href={pageHref(basePath, n)}
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
            href={pageHref(basePath, page + 1)}
            className="js-catalog-page js-catalog-page--more"
          >
            Показать еще
          </a>
        )}
      </div>
    </div>
  );
}
