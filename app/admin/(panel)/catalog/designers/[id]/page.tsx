import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getDesignerById } from '@/lib/designers/repository';
import { getStorage } from '@/lib/storage';
import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../../_components/Forbidden';
import { guardCatalog } from '../../_components/guard';
import { DesignerForm } from '../../_components/DesignerForm';

/**
 * Карточка дизайнера (§9, ADR §4.4). Чтение — catalog.read; правки/аватар —
 * catalog.write (в Server Action). Зеркало карточки бренда.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function DesignerDetailPage({
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
  const [designer, localeConfig] = await Promise.all([getDesignerById(id), getLocaleConfig()]);
  if (!designer) {
    notFound();
  }
  const storage = getStorage();
  const designerView = {
    ...designer,
    imageUrl: designer.imageKey ? storage.url(designer.imageKey) : null,
  };

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label={t('layout.breadcrumbs.ariaLabel')}>
        <Link href="/admin/catalog/designers" className="text-blue-700 hover:underline">
          {t('catalog.list.nav.designers')}
        </Link>{' '}
        / {designer.name}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">{designer.name}</h1>

      <div className="mt-6">
        <DesignerForm
          designer={designerView}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
