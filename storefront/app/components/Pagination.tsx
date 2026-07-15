/**
 * Пагинация каталога — порт frontend/views/misc_blocks/pagination.twig
 * (.pagination / .pagination-list / .pagination__page(--active) + «Показать еще»).
 * Страницы — через query `?page=N` (N ≥ 1); page=1 отдаётся без параметра.
 * Активная сортировка (`sort`) СОХРАНЯЕТСЯ во всех ссылках пагинации — иначе смена
 * страницы молча сбрасывала бы порядок к дефолту (created_at DESC).
 */

interface Props {
  /** Текущая страница, 1-based. */
  page: number;
  /** Всего страниц. */
  pageCount: number;
  /** Базовый путь без query, напр. `/catalog/twilly`. */
  basePath: string;
  /** Активная сортировка (carre: asc/desc); переносится в ссылки страниц. */
  sort?: string;
}

function pageHref(basePath: string, n: number, sort?: string): string {
  const params = new URLSearchParams();
  if (n > 1) params.set('page', String(n));
  if (sort) params.set('sort', sort);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export default function Pagination({ page, pageCount, basePath, sort }: Props) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return (
    <div className="pagination">
      <div className="pagination__nav">
        <div className="pagination-list">
          {pages.map((n) => (
            <a
              key={n}
              href={pageHref(basePath, n, sort)}
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
            href={pageHref(basePath, page + 1, sort)}
            className="js-catalog-page js-catalog-page--more"
          >
            Показать еще
          </a>
        )}
      </div>
    </div>
  );
}
