import { getTranslations } from 'next-intl/server';

import { getEffectiveSettings } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardSettings } from '../_components/guard';
import { SeoSettingsForm } from '../_components/SeoSettingsForm';

/**
 * Раздел «Настройки → SEO» (docs/11 §5.3.5).
 *
 * Серверная страница: guard settings.manage (core, без модуля). Рендерит форму
 * SEO-настроек магазина (site_url/title_template/og/robots/noindex), передавая
 * эффективные значения (env ⊕ БД). Мутация — updateShopSeoSettings.
 *
 * force-dynamic: читает БД/cookies — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function SeoSettingsPage() {
  const t = await getTranslations();
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const eff = await getEffectiveSettings();

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t('settings.seoPage.title')}
        subtitle={t('settings.seoPage.subtitle')}
        breadcrumbs={[
          { label: t('nav.settings'), href: '/admin/settings' },
          { label: t('seo.legend') },
        ]}
        backHref="/admin/settings"
        backLabel={t('settings.seoPage.backToSettings')}
      />

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <SeoSettingsForm seo={eff.seo} i18n={eff.i18n} translations={eff.contentI18n} />
      </section>
    </div>
  );
}
