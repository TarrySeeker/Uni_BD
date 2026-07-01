import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { AttributeForm } from '../_components/AttributeForm';

/**
 * Создание характеристики (docs/06 §4.5, F3 аудита). Доступ — catalog.write;
 * создаёт через createAttribute. Для типа «Список значений (select)» словарь
 * значений редактируется после создания (нужен attributeId).
 *
 * force-dynamic: читает cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewAttributePage() {
  const guard = await guardCatalog('catalog.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  return (
    <div>
      <PageHeader
        title="Новая характеристика"
        subtitle="После создания для типа «Список значений» станет доступен словарь значений."
        breadcrumbs={[
          { label: 'Каталог', href: '/admin/catalog' },
          { label: 'Характеристики', href: '/admin/catalog/attributes' },
          { label: 'Новая характеристика' },
        ]}
        backHref="/admin/catalog/attributes"
        backLabel="К списку характеристик"
      />

      <div className="mt-6">
        <AttributeForm attribute={null} />
      </div>
    </div>
  );
}
