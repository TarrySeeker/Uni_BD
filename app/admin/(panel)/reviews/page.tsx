import Link from 'next/link';

import {
  listReviewsForModeration,
  countReviews,
  countReviewsByStatus,
  type ReviewModerationFilter,
} from '@/lib/reviews/repository';
import { REVIEW_STATUSES, type ReviewStatus } from '@/lib/reviews/types';
import { formatDateTime } from '@/lib/admin/order-format';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardReviews } from './_components/guard';
import { ReviewStatusBadge } from './_components/ReviewStatusBadge';
import { RatingStars } from './_components/RatingStars';
import { ReviewRowActions } from './_components/ReviewRowActions';

/**
 * Раздел «Отзывы» — очередь модерации (docs/24 §4, образец /admin/leads +
 * пагинация /admin/news). Доступ — guardReviews (модуль reviews + reviews.read).
 * По умолчанию показываем очередь pending; фильтр статуса + пагинация из URL.
 * Модерация (approve/reject/вернуть/удалить) — reviews.write (в Server Action).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

function parseFilter(
  sp: Record<string, string | string[] | undefined>,
): ReviewModerationFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const rawStatus = one('status');
  const page = Number(one('page') ?? '1');
  return {
    status: REVIEW_STATUSES.includes(rawStatus as ReviewStatus)
      ? (rawStatus as ReviewStatus)
      : undefined,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: PAGE_SIZE,
  };
}

function pageHref(
  sp: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'page') continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set('page', String(page));
  return `/admin/reviews?${next.toString()}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default async function ReviewsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardReviews('reviews.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="reviews (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const filter = parseFilter(sp);
  const [{ rows, total }, totalAll, pendingCount] = await Promise.all([
    listReviewsForModeration(filter),
    countReviews(),
    countReviewsByStatus('pending'),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(filter.page, totalPages);

  return (
    <div>
      <PageHeader
        title="Отзывы"
        subtitle={`Модерация отзывов покупателей. На модерации: ${pendingCount}. Всего: ${totalAll}.`}
        breadcrumbs={[{ label: 'Отзывы' }]}
      />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="reviews-status"
            className="block text-xs font-medium text-gray-600"
          >
            Статус
          </label>
          <select
            id="reviews-status"
            name="status"
            defaultValue={filter.status ?? ''}
            className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Все</option>
            <option value="pending">На модерации</option>
            <option value="approved">Одобрены</option>
            <option value="rejected">Отклонены</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100"
        >
          Применить
        </button>
        {filter.status ? (
          <Link
            href="/admin/reviews"
            className="px-2 py-2 text-sm text-gray-500 hover:underline"
          >
            Сбросить
          </Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="px-4 py-2 font-medium">Дата</th>
              <th className="px-4 py-2 font-medium">Товар</th>
              <th className="px-4 py-2 font-medium">Автор</th>
              <th className="px-4 py-2 font-medium">Рейтинг</th>
              <th className="px-4 py-2 font-medium">Текст</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                  Отзывы не найдены.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {r.productName ?? '—'}
                  </td>
                  <td className="px-4 py-2">{r.authorName}</td>
                  <td className="px-4 py-2">
                    <RatingStars value={r.rating} />
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    <Link
                      href={`/admin/reviews/${r.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {truncate(r.body, 80)}
                    </Link>
                    {r.reply ? (
                      <div className="mt-1 text-xs text-gray-500">
                        Ответ: {truncate(r.reply, 60)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <ReviewStatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2">
                    <ReviewRowActions id={r.id} status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          aria-label="Пагинация"
        >
          <span className="text-gray-500">
            Страница {currentPage} из {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link
                href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Назад
              </Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link
                href={pageHref(sp, currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Вперёд
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
