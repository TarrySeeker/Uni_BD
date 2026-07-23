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
  const guard = await guardCatalog('catalog.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const localeConfig = await getLocaleConfig();

  return (
    <div>
      <PageHeader
        title="Новый дизайнер"
        subtitle="После создания станут доступны загрузка аватара и OG/переводы."
        breadcrumbs={[
          { label: 'Каталог', href: '/admin/catalog' },
          { label: 'Дизайнеры', href: '/admin/catalog/designers' },
          { label: 'Новый дизайнер' },
        ]}
        backHref="/admin/catalog/designers"
        backLabel="К списку дизайнеров"
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
