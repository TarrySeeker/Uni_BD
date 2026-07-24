import { getTranslations } from 'next-intl/server';

import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardGift } from '../_components/guard';
import { GiftCertificateForm } from '../_components/GiftCertificateForm';

/**
 * Выпуск подарочного сертификата (docs/24 §5). Право gift.write. Форма —
 * GiftCertificateForm в режиме создания (issueGiftCertificate на сервере).
 *
 * force-dynamic: гвард читает cookie/БД — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewGiftCertificatePage() {
  const t = await getTranslations();
  const guard = await guardGift('gift.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('giftCertificates.newPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const localeConfig = await getLocaleConfig();

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={t('giftCertificates.newPage.title')}
        breadcrumbs={[{ label: t('nav.giftCertificates'), href: '/admin/gift-certificates' }, { label: t('giftCertificates.newPage.breadcrumbNew') }]}
        backHref="/admin/gift-certificates"
        backLabel={t('giftCertificates.newPage.backLabel')}
      />
      <div className="mt-6">
        <GiftCertificateForm
          cert={null}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
