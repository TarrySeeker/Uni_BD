import Link from 'next/link';

import { listCmsPages, type CmsPageListFilter } from '@/lib/cms/repository';
import { CMS_PAGE_STATUSES, type CmsPageStatus } from '@/lib/cms/types';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardCms } from './_components/guard';
import { StatusBadge } from './_components/StatusBadge';

/**
 * Список CMS-страниц (docs/11 §5.1.5, пакет 5.C-3).
 *
 * Серверная загрузка через listCmsPages: поиск (title/slug) + фильтр статуса +
 * пагинация — из searchParams (URL = состояние, shareable), образец /admin/catalog.
 * Доступ — серверный (guardCms: модуль cms + cms.read). Выключенный модуль не
 * отдаёт раздел.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/** searchParams → строго типизированный фильтр listCmsPages. */
function parseFilter(
  sp: Record<string, string | string[] | undefined>,
): CmsPageListFilter {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const status = one('status');
  const page = Number(one('page') ?? '1');
  return {
    search: one('search') || undefined,
    status: CMS_PAGE_STATUSES.includes(status as CmsPageStatus)
      ? (status as CmsPageStatus)
      : undefined,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: PAGE_SIZE,
  };
}

/** Сохраняет текущие фильтры, меняя только page (для ссылок пагинации). */
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
  return `/admin/cms?${next.toString()}`;
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

export default async function CmsPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardCms('cms.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="cms (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const filter = parseFilter(sp);
  const { rows, total } = await listCmsPages(filter);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(filter.page, totalPages);

  return (
    <div>
      <PageHeader
        title="Контент — страницы"
        subtitle={`Найдено страниц: ${total}.`}
        breadcrumbs={[{ label: 'Контент' }]}
        action={
          <Link
            href="/admin/cms/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать страницу
          </Link>
        }
      />

      {/* Поиск + фильтр статуса (GET-форма → searchParams). */}
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="cms-search" className="block text-xs font-medium text-gray-600">
            Поиск
          </label>
          <input
            id="cms-search"
            name="search"
            defaultValue={filter.search ?? ''}
            placeholder="Название или slug"
            className="mt-1 w-64 rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="cms-status" className="block text-xs font-medium text-gray-600">
            Статус
          </label>
          <select
            id="cms-status"
            name="status"
            defaultValue={filter.status ?? ''}
            className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Все</option>
            <option value="draft">Черновик</option>
            <option value="published">Опубликована</option>
            <option value="archived">В архиве</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100"
        >
          Применить
        </button>
        {(filter.search || filter.status) ? (
          <Link href="/admin/cms" className="px-2 py-2 text-sm text-gray-500 hover:underline">
            Сбросить
          </Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Название</th>
              <th scope="col" className="px-4 py-2 font-medium">Slug</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="px-4 py-2 font-medium">Опубликована</th>
              <th scope="col" className="px-4 py-2 font-medium">Изменена</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Страницы не найдены. Измените фильтры или создайте страницу.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/cms/${row.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {row.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    <code className="text-xs">{row.slug}</code>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2 text-gray-600">{formatDate(row.publishedAt)}</td>
                  <td className="px-4 py-2 text-gray-600">{formatDate(row.updatedAt)}</td>
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
