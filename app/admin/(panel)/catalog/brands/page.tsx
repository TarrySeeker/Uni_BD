import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

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
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
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
        title={t('catalog.list.nav.brands')}
        subtitle={t('catalog.brand.listSubtitle')}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: t('catalog.list.nav.brands') },
        ]}
        backHref="/admin/catalog"
        backLabel={t('catalog.common.backToCatalog')}
        action={
          <Link
            href="/admin/catalog/brands/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            {t('catalog.brand.createLink')}
          </Link>
        }
      />

      <div className="mt-6">
        <BrandList brands={items} />
      </div>
    </div>
  );
}
