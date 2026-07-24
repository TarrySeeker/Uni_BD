import { getTranslations } from 'next-intl/server';

import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { BrandForm } from '../../_components/BrandForm';

/**
 * Создание бренда (docs/06 §3.3, П4.4). Доступ — catalog.write; создаёт через
 * createBrand. Логотип загружается после создания (нужен brandId).
 *
 * force-dynamic: читает cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewBrandPage() {
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const localeConfig = await getLocaleConfig();

  return (
    <div>
      <PageHeader
        title={t('catalog.brand.newTitle')}
        subtitle={t('catalog.brand.newSubtitle')}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: t('catalog.list.nav.brands'), href: '/admin/catalog/brands' },
          { label: t('catalog.brand.newTitle') },
        ]}
        backHref="/admin/catalog/brands"
        backLabel={t('catalog.brand.backToList')}
      />

      <div className="mt-6">
        <BrandForm
          brand={null}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
