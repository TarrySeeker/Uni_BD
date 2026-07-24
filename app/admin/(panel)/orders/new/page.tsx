import { getTranslations } from 'next-intl/server';

import { getEnv } from '@/lib/config/env';
import { paymentMethodLabel, deliveryTypeLabel } from '@/lib/admin/order-format';
import { PAYMENT_METHODS, DELIVERY_TYPES } from '@/lib/orders/types';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardOrders } from '../_components/guard';
import { ManualOrderForm } from '../_components/ManualOrderForm';

/**
 * Ручное создание заказа из админки (Batch 4 аудита, F4): экшен createManualOrder
 * существовал, но был недостижим — нет страницы/кнопки. Эта страница (RBAC:
 * orders.write) даёт владельцу форму, собирающую payload под ManualOrderSchema.
 *
 * Доступ — guardOrders('orders.write'): сам сабмит тоже требует orders.write
 * (createManualOrder), но страницу скрываем заранее (UI-фильтр + серверная проверка).
 *
 * force-dynamic: читает cookies/настройки — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  const t = await getTranslations();
  const guard = await guardOrders('orders.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('orders.newPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const currency = getEnv().SHOP_CURRENCY;

  // Списки способов оплаты/доставки с русскими лейблами — из единого источника
  // (order-format), без хардкода в форме. Так новый магазин не правит форму.
  const paymentOptions = PAYMENT_METHODS.map((m) => ({
    value: m,
    label: paymentMethodLabel(m),
  }));
  const deliveryOptions = DELIVERY_TYPES.map((t) => ({
    value: t,
    label: deliveryTypeLabel(t),
  }));

  return (
    <div>
      <PageHeader
        title={t('orders.newPage.title')}
        subtitle={t('orders.newPage.subtitle')}
        breadcrumbs={[{ label: t('nav.orders'), href: '/admin/orders' }, { label: t('orders.newPage.title') }]}
        backHref="/admin/orders"
        backLabel={t('orders.newPage.backLabel')}
      />

      <div className="mt-6">
        <ManualOrderForm
          currency={currency}
          paymentOptions={paymentOptions}
          deliveryOptions={deliveryOptions}
        />
      </div>
    </div>
  );
}
