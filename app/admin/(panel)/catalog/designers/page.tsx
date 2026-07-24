import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listDesigners } from '@/lib/designers/repository';
import {
  ADMIN_DEFAULT_DESIGNER_SORT,
  parseDesignerListParams,
} from '@/lib/designers/sort';
import { getLocaleConfig } from '@/lib/i18n';
import { getStorage } from '@/lib/storage';

import { DESIGNER_LIST_PATH, buildDesignerHref } from '../_components/designer-list-url';
import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCatalog } from '../_components/guard';
import { DesignerList } from '../_components/DesignerList';

/**
 * Список дизайнеров (§9, ADR §4.4). Чтение — catalog.read; CRUD — через Server
 * Actions (catalog.write на сервере). Зеркало страницы брендов.
 *
 * Поиск и порядок живут в URL (GET-форма) — состояние шарится ссылкой и переживает
 * refresh после удаления. Дефолт админки — алфавит А-Я; алфавит считает
 * Intl.Collator по языку магазина (lib/designers/sort.ts), не коллация БД.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function DesignersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const params = parseDesignerListParams(sp, { defaultSort: ADMIN_DEFAULT_DESIGNER_SORT });
  const { defaultLocale } = await getLocaleConfig();

  const designers = await listDesigners({
    search: params.search,
    sort: params.sort,
    locale: defaultLocale,
  });
  const storage = getStorage();
  const items = designers.map((d) => ({
    ...d,
    imageUrl: d.imageKey ? storage.url(d.imageKey) : null,
  }));

  const isFiltered = Boolean(params.search) || params.sort !== ADMIN_DEFAULT_DESIGNER_SORT;
  // Состояние списка тащим за собой в форму, чтобы «Отмена» вернула тот же экран.
  // Пока фильтров нет — адреса остаются голыми.
  const listQuery = isFiltered
    ? new URLSearchParams({ ...(params.search ? { search: params.search } : {}), sort: params.sort }).toString()
    : '';

  return (
    <div>
      <PageHeader
        title={t('catalog.list.nav.designers')}
        subtitle={t('catalog.designer.listSubtitle', { count: items.length })}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: t('catalog.list.nav.designers') },
        ]}
        backHref="/admin/catalog"
        backLabel={t('catalog.common.backToCatalog')}
        action={
          <Link
            href={buildDesignerHref(`${DESIGNER_LIST_PATH}/new`, listQuery)}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            {t('catalog.designer.createLink')}
          </Link>
        }
      />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="designer-search" className="block text-xs font-medium text-gray-600">
            {t('catalog.designer.searchLabel')}
          </label>
          <input
            id="designer-search"
            name="search"
            defaultValue={params.search ?? ''}
            placeholder={t('catalog.designer.searchPlaceholder')}
            className="mt-1 w-64 rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="designer-sort" className="block text-xs font-medium text-gray-600">
            {t('catalog.designer.sortLabel')}
          </label>
          <select
            id="designer-sort"
            name="sort"
            defaultValue={params.sort}
            className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="name_asc">{t('catalog.designer.sort.nameAsc')}</option>
            <option value="name_desc">{t('catalog.designer.sort.nameDesc')}</option>
            <option value="manual">{t('catalog.designer.sort.manual')}</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100"
        >
          {t('common.actions.apply')}
        </button>
        {isFiltered ? (
          <Link
            href="/admin/catalog/designers"
            className="px-2 py-2 text-sm text-gray-500 hover:underline"
          >
            {t('common.actions.reset')}
          </Link>
        ) : null}
      </form>

      <div className="mt-6">
        {items.length === 0 && params.search ? (
          <p className="rounded-lg border border-gray-200 px-4 py-6 text-center text-sm text-gray-400">
            {t('catalog.designer.searchEmpty')}
          </p>
        ) : (
          <DesignerList designers={items} />
        )}
      </div>
    </div>
  );
}
