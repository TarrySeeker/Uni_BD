import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

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
  const t = await getTranslations();
  const guard = await guardNews('news.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('news.page.moduleDisabled')} />;
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
        title={t('news.page.title')}
        subtitle={t('news.page.subtitle', { total })}
        breadcrumbs={[{ label: t('news.page.title') }]}
        action={
          <Link href="/admin/news/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700">
            {t('news.page.createButton')}
          </Link>
        }
      />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="news-search" className="block text-xs font-medium text-gray-600">{t('news.page.searchLabel')}</label>
          <input id="news-search" name="search" defaultValue={filter.search ?? ''}
            placeholder={t('news.page.searchPlaceholder')}
            className="mt-1 w-64 rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="news-status" className="block text-xs font-medium text-gray-600">{t('news.page.statusLabel')}</label>
          <select id="news-status" name="status" defaultValue={filter.status ?? ''}
            className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="">{t('news.page.statusAll')}</option>
            <option value="draft">{t('news.page.status.draft')}</option>
            <option value="published">{t('news.page.status.published')}</option>
            <option value="archived">{t('news.page.status.archived')}</option>
          </select>
        </div>
        <button type="submit" className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100">
          {t('common.actions.apply')}
        </button>
        {(filter.search || filter.status) ? (
          <Link href="/admin/news" className="px-2 py-2 text-sm text-gray-500 hover:underline">{t('common.actions.reset')}</Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{t('news.page.columns.title')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('news.page.columns.group')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('news.page.columns.status')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('news.page.columns.publishedAt')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('news.page.columns.sortOrder')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  {t('news.page.empty')}
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
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label={t('news.page.paginationAria')}>
          <span className="text-gray-500">{t('common.pagination.page', { page: currentPage, total: totalPages })}</span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">{t('common.pagination.prev')}</Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link href={pageHref(sp, currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100">{t('news.page.forward')}</Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
