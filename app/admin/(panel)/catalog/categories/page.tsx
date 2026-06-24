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
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const tree = await getCategoryTree();

  return (
    <div>
      <PageHeader
        title="Категории"
        subtitle="Группы, по которым товары раскладываются в каталоге на сайте. Категорию с подкатегориями удалить нельзя — сначала перенесите или удалите вложенные."
        breadcrumbs={[{ label: 'Каталог', href: '/admin/catalog' }, { label: 'Категории' }]}
        backHref="/admin/catalog"
        backLabel="К каталогу"
      />

      <div className="mt-6">
        <CategoryManager tree={tree} />
      </div>
    </div>
  );
}
