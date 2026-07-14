import Link from 'next/link';

import { listNews, type NewsListFilter } from '@/lib/news/repository';
import { NEWS_STATUSES, type NewsStatus } from '@/lib/news/types';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardNews } from './_components/guard';
import { NewsStatusBadge } from './_components/NewsStatusBadge';

/**
 * Список новостей (docs/24 §3, образец /admin/cms). Серверная загрузка через
 * listNews: поиск (title/slug/group) + фильтр статуса + реальная пагинация из
 * searchParams (URL = состояние). Доступ — серверный (guardNews: модуль news +
 * news.read). Выключенный модуль не отдаёт раздел.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

function parseFilter(
  sp: Record<string, string | string[] | undefined>,
): NewsListFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const status = one('status');
  const page = Number(one('page') ?? '1');
  return {
    search: one('search') || undefined,
    status: NEWS_STATUSES.includes(status as NewsStatus)
      ? (status as NewsStatus)
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
  return `/admin/news?${next.toString()}`;
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

export default async function NewsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardNews('news.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="news (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const filter = parseFilter(sp);
  const { rows, total } = await listNews(filter);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(filter.page, totalPages);

  return (
    <div>
      <PageHeader
        title="Новости"
        subtitle={`Найдено новостей: ${total}.`}
        breadcrumbs={[{ label: 'Новости' }]}
        action={
          <Link href="/admin/news/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700">
            + Создать новость
          </Link>
        }
      />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="news-search" className="block text-xs font-medium text-gray-600">Поиск</label>
          <input id="news-search" name="search" defaultValue={filter.search ?? ''}
            placeholder="Заголовок, slug или раздел"
            className="mt-1 w-64 rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="news-status" className="block text-xs font-medium text-gray-600">Статус</label>
          <select id="news-status" name="status" defaultValue={filter.status ?? ''}
            className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="">Все</option>
            <option value="draft">Черновик</option>
            <option value="published">Опубликована</option>
            <option value="archived">В архиве</option>
          </select>
        </div>
        <button type="submit" className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100">
          Применить
        </button>
        {(filter.search || filter.status) ? (
          <Link href="/admin/news" className="px-2 py-2 text-sm text-gray-500 hover:underline">Сбросить</Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Заголовок</th>
              <th scope="col" className="px-4 py-2 font-medium">Раздел</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="px-4 py-2 font-medium">Опубликована</th>
              <th scope="col" className="px-4 py-2 font-medium">Порядок</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Новости не найдены. Измените фильтры или создайте новость.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/admin/news/${row.id}`} className="font-medium text-blue-700 hover:underline">
                      {row.title}
                    </Link>
                    <div className="text-xs text-gray-500"><code>{row.slug}</code></div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{row.groupLabel ?? '—'}</td>
                  <td className="px-4 py-2"><NewsStatusBadge status={row.status} /></td>
                  <td className="px-4 py-2 text-gray-600">{formatDate(row.publishedAt)}</td>
                  <td className="px-4 py-2 text-gray-600">{row.sortOrder}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Пагинация">
          <span className="text-gray-500">Страница {currentPage} из {totalPages}</span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">Назад</Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link href={pageHref(sp, currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">Вперёд</Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
