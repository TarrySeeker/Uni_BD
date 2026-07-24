import { getTranslations } from 'next-intl/server';

import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { DesignerForm } from '../../_components/DesignerForm';

/**
 * Создание дизайнера (§9, ADR §4.4). Доступ — catalog.write; создаёт через
 * createDesigner. Аватар загружается после создания (нужен designerId).
 *
 * force-dynamic: читает cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewDesignerPage() {
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
        title={t('catalog.designer.newTitle')}
        subtitle={t('catalog.designer.newSubtitle')}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: t('catalog.list.nav.designers'), href: '/admin/catalog/designers' },
          { label: t('catalog.designer.newTitle') },
        ]}
        backHref="/admin/catalog/designers"
        backLabel={t('catalog.designer.backToList')}
      />

      <div className="mt-6">
        <DesignerForm
          designer={null}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
