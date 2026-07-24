import { getTranslations } from 'next-intl/server';

import { getCategoryTree } from '@/lib/catalog/repository';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCatalog } from '../_components/guard';
import { CategoryManager } from '../_components/CategoryManager';

/**
 * Дерево категорий (docs/05 §5.4, П4.3). Чтение — catalog.read; CRUD/move/delete —
 * через Server Actions (catalog.write на сервере). Защита от циклов и RESTRICT —
 * на бэке (moveCategory/deleteCategory).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function CategoriesPage() {
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const tree = await getCategoryTree();

  return (
    <div>
      <PageHeader
        title={t('catalog.list.nav.categories')}
        subtitle={t('catalog.category.listSubtitle')}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: t('catalog.list.nav.categories') },
        ]}
        backHref="/admin/catalog"
        backLabel={t('catalog.common.backToCatalog')}
      />

      <div className="mt-6">
        <CategoryManager tree={tree} />
      </div>
    </div>
  );
}
