import Link from 'next/link';

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
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
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
        title="Характеристики"
        subtitle="Справочник характеристик товаров: цвет, размер и т.п. Значения select собираются в словарь."
        breadcrumbs={[{ label: 'Каталог', href: '/admin/catalog' }, { label: 'Характеристики' }]}
        backHref="/admin/catalog"
        backLabel="К каталогу"
        action={
          <Link
            href="/admin/catalog/attributes/new"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Создать характеристику
          </Link>
        }
      />

      <div className="mt-6">
        <AttributeList attributes={items} />
      </div>
    </div>
  );
}
