import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listAttributes, listAttributeValuesByAttribute } from '@/lib/catalog/repository';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCatalog } from '../_components/guard';
import { AttributeList, type AttributeListItem } from './_components/AttributeList';

/**
 * Справочник характеристик товара (docs/06 §4.5, F3 аудита тупиков).
 * Раздел был недостижим: серверные экшены создания/правки атрибутов и значений
 * существовали, но не было страницы управления. Чтение — catalog.read; CRUD —
 * через Server Actions (catalog.write на сервере).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function AttributesPage() {
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const [attributes, valuesByAttr] = await Promise.all([
    listAttributes(),
    listAttributeValuesByAttribute(),
  ]);
  const items: AttributeListItem[] = attributes.map((a) => ({
    ...a,
    valuesCount: valuesByAttr[a.id]?.length ?? 0,
  }));

  return (
    <div>
      <PageHeader
        title={t('catalog.list.nav.attributes')}
        subtitle={t('catalog.attribute.pageSubtitle')}
        breadcrumbs={[{ label: t('nav.catalog'), href: '/admin/catalog' }, { label: t('catalog.list.nav.attributes') }]}
        backHref="/admin/catalog"
        backLabel={t('catalog.common.backToCatalog')}
        action={
          <Link
            href="/admin/catalog/attributes/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            {t('catalog.attribute.createLink')}
          </Link>
        }
      />

      <div className="mt-6">
        <AttributeList attributes={items} />
      </div>
    </div>
  );
}
