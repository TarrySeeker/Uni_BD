import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getBrandById } from '@/lib/catalog/repository';
import { getStorage } from '@/lib/storage';
import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../../_components/Forbidden';
import { guardCatalog } from '../../_components/guard';
import { BrandForm } from '../../_components/BrandForm';

/**
 * Карточка бренда (docs/06 §3.3, П4.4). Чтение — catalog.read; правки/лого —
 * catalog.write (проверяется в Server Action).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function BrandDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const [brand, localeConfig] = await Promise.all([getBrandById(id), getLocaleConfig()]);
  if (!brand) {
    notFound();
  }
  // Резолвим ключ логотипа в публичный URL на сервере (как og:image) — для <img>.
  const storage = getStorage();
  const brandView = {
    ...brand,
    logoUrl: brand.logoKey ? storage.url(brand.logoKey) : null,
  };

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label={t('layout.breadcrumbs.ariaLabel')}>
        <Link href="/admin/catalog/brands" className="text-blue-700 hover:underline">
          {t('catalog.list.nav.brands')}
        </Link>{' '}
        / {brand.name}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">{brand.name}</h1>

      <div className="mt-6">
        <BrandForm
          brand={brandView}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
