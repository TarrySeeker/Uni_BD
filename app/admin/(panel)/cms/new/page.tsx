import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../_components/Forbidden';
import { guardCms } from '../_components/guard';
import { PageForm } from '../_components/PageForm';

/**
 * Создание CMS-страницы (docs/11 §5.1.5, пакет 5.C-3). Доступ к странице —
 * cms.read; сам сабмит создаёт через createCmsPage (cms.write + assertCmsEnabled).
 *
 * force-dynamic: читает cookies/сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewCmsPage() {
  const t = await getTranslations();
  const guard = await guardCms('cms.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('cms.newPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const localeConfig = await getLocaleConfig();

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label={t('layout.breadcrumbs.ariaLabel')}>
        <Link href="/admin/cms" className="text-blue-700 hover:underline">
          {t('nav.cms')}
        </Link>{' '}
        / {t('cms.newPage.breadcrumbCurrent')}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">{t('cms.newPage.title')}</h1>
      <p className="mt-1 text-sm text-gray-600">
        {t('cms.newPage.subtitle')}
      </p>

      <div className="mt-6">
        <PageForm
          page={null}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
