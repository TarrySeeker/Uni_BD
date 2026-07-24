import { getTranslations } from 'next-intl/server';

import { getSetting } from '@/lib/settings/repository';
import { parseSettingValue } from '@/lib/settings/schemas';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardSettings } from '../_components/guard';
import { ResetSettingButton } from '../_components/ResetSettingButton';
import { GiftSettingsForm } from './GiftSettingsForm';

/**
 * Раздел «Настройки → Подарочные сертификаты» (ТЗ владельца п.11).
 *
 * Серверная страница: guard settings.manage (core, без модуля — как и остальные
 * настройки). Показывает СЫРОЙ оверрайд ключа `gift`: форма сама накладывает его
 * на дефолты платформы (resolveGiftSettings), поэтому «сброс» реально возвращает
 * магазин к дефолтам, а не к тому, что когда-то сохранили.
 *
 * force-dynamic: читает БД/cookies — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function GiftSettingsPage() {
  const t = await getTranslations();
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const row = await getSetting('gift');
  const saved = parseSettingValue('gift', row?.value) ?? {};

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t('nav.giftCertificates')}
        subtitle={t('settings.giftPage.subtitle')}
        breadcrumbs={[
          { label: t('nav.settings'), href: '/admin/settings' },
          { label: t('nav.giftCertificates') },
        ]}
        backHref="/admin/settings"
        backLabel={t('settings.giftPage.backToSettings')}
      />

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <GiftSettingsForm saved={saved} />
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
          <ResetSettingButton settingKey="gift" label={t('settings.giftPage.resetLabel')} />
        </div>
      </section>
    </div>
  );
}
