import { getTranslations } from 'next-intl/server';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardOrders } from '../../orders/_components/guard';
import { PromoForm } from '../_components/PromoForm';
import { loadPromoPickerData } from '../_components/picker-data';

/**
 * Создание промокода (docs/07 §5). Право orders.write (guardOrders). Форма —
 * PromoForm в режиме создания (createPromoCode на сервере).
 *
 * force-dynamic: гвард читает cookie/БД — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewPromoPage() {
  const t = await getTranslations();
  const guard = await guardOrders('orders.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('promo.newPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const pickerData = await loadPromoPickerData();

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={t('promo.newPage.title')}
        breadcrumbs={[
          { label: t('nav.promo'), href: '/admin/promo' },
          { label: t('promo.newPage.breadcrumbNew') },
        ]}
        backHref="/admin/promo"
        backLabel={t('promo.newPage.backToList')}
      />
      <div className="mt-6">
        <PromoForm promo={null} pickerData={pickerData} />
      </div>
    </div>
  );
}
