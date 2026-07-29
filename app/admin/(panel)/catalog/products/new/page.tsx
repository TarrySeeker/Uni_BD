import { getTranslations } from 'next-intl/server';

import { listBrands, getCategoryTree, listAttributes } from '@/lib/catalog/repository';
import { listDesigners } from '@/lib/designers/repository';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getLocaleConfig } from '@/lib/i18n';

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
  const t = await getTranslations();
  const guard = await guardCatalog('catalog.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('catalog.list.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  // Локаль магазина нужна ДО списка дизайнеров: без неё коллатор берёт системную
  // локаль контейнера (en-US), и кириллические имена встают не туда, где их ждёт
  // раздел «Дизайнеры» — два экрана показали бы разный алфавит.
  const { defaultLocale } = await getLocaleConfig();

  const [brands, designers, categoryTree, attributes, settings, localeConfig] = await Promise.all([
    listBrands(),
    // Алфавит: в форме товара дизайнера ищут глазами по списку (запрос заказчика).
    listDesigners({ sort: 'name_asc', locale: defaultLocale }),
    getCategoryTree(),
    listAttributes(),
    getEffectiveSettings(),
    getLocaleConfig(),
  ]);

  return (
    <div>
      <PageHeader
        title={t('catalog.product.newTitle')}
        subtitle={t('catalog.product.newSubtitle')}
        breadcrumbs={[{ label: t('nav.catalog'), href: '/admin/catalog' }, { label: t('catalog.product.newTitle') }]}
        backHref="/admin/catalog"
        backLabel={t('catalog.product.backToList')}
      />

      <div className="mt-6">
        <ProductForm
          product={null}
          brands={brands}
          designers={designers}
          categoryTree={categoryTree}
          attributes={attributes}
          masterColors={settings.catalog.masterColors}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
          displayCurrencies={settings.exchange.displayCurrencies}
        />
      </div>
    </div>
  );
}
