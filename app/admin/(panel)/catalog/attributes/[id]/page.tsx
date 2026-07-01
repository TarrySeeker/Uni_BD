import Link from 'next/link';
import { notFound } from 'next/navigation';

import { listAttributes, listAttributeValues } from '@/lib/catalog/repository';

import { Forbidden } from '../../../_components/Forbidden';
import { guardCatalog } from '../../_components/guard';
import { AttributeForm } from '../_components/AttributeForm';
import { AttributeValues } from '../_components/AttributeValues';

/**
 * Карточка характеристики (docs/06 §4.5, F3 аудита). Чтение — catalog.read;
 * правки и добавление значений — catalog.write (проверяется в Server Action).
 *
 * Характеристику берём из listAttributes (фильтр по id) — отдельного
 * getAttributeById в репозитории нет, переиспользуем существующее чтение.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function AttributeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const attributes = await listAttributes();
  const attribute = attributes.find((a) => a.id === id);
  if (!attribute) {
    notFound();
  }
  // Словарь значений нужен только для select; для прочих типов передаём пустой.
  const values =
    attribute.type === 'select' ? await listAttributeValues(attribute.id) : [];

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/catalog/attributes" className="text-blue-700 hover:underline">
          Характеристики
        </Link>{' '}
        / {attribute.name}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">{attribute.name}</h1>

      <div className="mt-6">
        <AttributeForm attribute={attribute} />
      </div>

      <AttributeValues
        attributeId={attribute.id}
        values={values}
        editable={attribute.type === 'select'}
      />
    </div>
  );
}
