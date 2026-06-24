import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { BrandForm } from '../../_components/BrandForm';

/**
 * Создание бренда (docs/06 §3.3, П4.4). Доступ — catalog.write; создаёт через
 * createBrand. Логотип загружается после создания (нужен brandId).
 *
 * force-dynamic: читает cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewBrandPage() {
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
        title="Новый бренд"
        subtitle="После создания станет доступна загрузка логотипа."
        breadcrumbs={[
          { label: 'Каталог', href: '/admin/catalog' },
          { label: 'Бренды', href: '/admin/catalog/brands' },
          { label: 'Новый бренд' },
        ]}
        backHref="/admin/catalog/brands"
        backLabel="К списку брендов"
      />

      <div className="mt-6">
        <BrandForm brand={null} />
      </div>
    </div>
  );
}
