import Link from 'next/link';

import { listBrands } from '@/lib/catalog/repository';
import { getStorage } from '@/lib/storage';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCatalog } from '../_components/guard';
import { BrandList } from '../_components/BrandList';

/**
 * Список брендов (docs/06 §3.3, П4.4). Чтение — catalog.read; CRUD —
 * через Server Actions (catalog.write на сервере).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function BrandsPage() {
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const brands = await listBrands();
  // Резолвим ключ логотипа в публичный URL на сервере (как og:image) — домен из
  // storage, не хардкод; компонент получает готовый logoUrl для <img>.
  const storage = getStorage();
  const items = brands.map((b) => ({
    ...b,
    logoUrl: b.logoKey ? storage.url(b.logoKey) : null,
  }));

  return (
    <div>
      <PageHeader
        title="Бренды"
        subtitle="Производители для фильтра и страниц бренда. Можно оставить пустым."
        breadcrumbs={[{ label: 'Каталог', href: '/admin/catalog' }, { label: 'Бренды' }]}
        backHref="/admin/catalog"
        backLabel="К каталогу"
        action={
          <Link
            href="/admin/catalog/brands/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать бренд
          </Link>
        }
      />

      <div className="mt-6">
        <BrandList brands={items} />
      </div>
    </div>
  );
}
