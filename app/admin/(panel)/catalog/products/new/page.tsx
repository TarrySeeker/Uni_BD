import { listBrands, getCategoryTree, listAttributes } from '@/lib/catalog/repository';

import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { ProductForm } from '../../_components/ProductForm';

/**
 * Создание товара (docs/05 §5.1, П4.2). Доступ к странице — catalog.read;
 * сам сабмит создаёт через createProduct (catalog.write).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  const guard = await guardCatalog('catalog.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const [brands, categoryTree, attributes] = await Promise.all([
    listBrands(),
    getCategoryTree(),
    listAttributes(),
  ]);

  return (
    <div>
      <PageHeader
        title="Новый товар"
        subtitle="Заполните основные поля и создайте товар. Варианты, характеристики, медиа и остатки станут доступны после создания."
        breadcrumbs={[{ label: 'Каталог', href: '/admin/catalog' }, { label: 'Новый товар' }]}
        backHref="/admin/catalog"
        backLabel="К списку товаров"
      />

      <div className="mt-6">
        <ProductForm
          product={null}
          brands={brands}
          categoryTree={categoryTree}
          attributes={attributes}
        />
      </div>
    </div>
  );
}
