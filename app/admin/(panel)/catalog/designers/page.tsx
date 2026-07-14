import Link from 'next/link';

import { listDesigners } from '@/lib/designers/repository';
import { getStorage } from '@/lib/storage';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCatalog } from '../_components/guard';
import { DesignerList } from '../_components/DesignerList';

/**
 * Список дизайнеров (§9, ADR §4.4). Чтение — catalog.read; CRUD — через Server
 * Actions (catalog.write на сервере). Зеркало страницы брендов.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function DesignersPage() {
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const designers = await listDesigners();
  const storage = getStorage();
  const items = designers.map((d) => ({
    ...d,
    imageUrl: d.imageKey ? storage.url(d.imageKey) : null,
  }));

  return (
    <div>
      <PageHeader
        title="Дизайнеры"
        subtitle="Персоны/авторы для страниц дизайнеров и привязки товаров. Можно оставить пустым."
        breadcrumbs={[{ label: 'Каталог', href: '/admin/catalog' }, { label: 'Дизайнеры' }]}
        backHref="/admin/catalog"
        backLabel="К каталогу"
        action={
          <Link
            href="/admin/catalog/designers/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать дизайнера
          </Link>
        }
      />

      <div className="mt-6">
        <DesignerList designers={items} />
      </div>
    </div>
  );
}
