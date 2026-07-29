import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  getProductById,
  listBrands,
  getCategoryTree,
  listAttributes,
  listAttributeValuesByAttribute,
} from '@/lib/catalog/repository';
import { listDesigners } from '@/lib/designers/repository';
import { listBlocksByProduct } from '@/lib/product-blocks';
import { can } from '@/lib/auth/rbac';
import { getLocaleConfig } from '@/lib/i18n';
import { getStorage } from '@/lib/storage';
import { getEffectiveSettings } from '@/lib/config/settings';

import { Forbidden } from '../../../_components/Forbidden';
import { PageHeader } from '../../../_components/PageHeader';
import { guardCatalog } from '../../_components/guard';
import { ProductForm } from '../../_components/ProductForm';
import { ProductBlocksEditor } from '../../_components/ProductBlocksEditor';

/**
 * Карточка товара (docs/05 §5.3, П4.2). Чтение — catalog.read; правки —
 * catalog.write (проверяется и в Server Action). Если права записи нет —
 * показываем форму в режиме «только чтение» недоступна: проще показать Forbidden
 * на мутации; здесь рендерим форму, а сервер отклонит запись без права.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
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
  const [product, brands, designers, categoryTree, attributes, attributeValues, localeConfig, blocks, settings] =
    await Promise.all([
      getProductById(id),
      listBrands(),
      // Алфавит: в форме товара дизайнера ищут глазами по списку (запрос заказчика).
      listDesigners({ sort: 'name_asc' }),
      getCategoryTree(),
      listAttributes(),
      listAttributeValuesByAttribute(),
      getLocaleConfig(),
      listBlocksByProduct(id),
      getEffectiveSettings(),
    ]);

  if (!product) {
    notFound();
  }

  const canWrite = can(guard.user, 'catalog.write');
  const storage = getStorage();
  const editorBlocks = blocks.map((b) => ({
    ...b,
    imageUrl: b.imageKey ? storage.url(b.imageKey) : null,
  }));
  const authors = designers.map((d) => ({ id: d.id, name: d.name }));

  return (
    <div>
      <PageHeader
        title={product.name}
        subtitle={t('catalog.product.detailSubtitle', { sku: product.sku })}
        breadcrumbs={[
          { label: t('nav.catalog'), href: '/admin/catalog' },
          { label: product.name },
        ]}
        backHref="/admin/catalog"
        backLabel={t('catalog.product.backToList')}
      />

      {!canWrite ? (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {t.rich('catalog.product.noWriteWarning', {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      ) : null}

      <div className="mt-6">
        <ProductForm
          product={product}
          brands={brands}
          designers={designers}
          categoryTree={categoryTree}
          attributes={attributes}
          attributeValues={attributeValues}
          masterColors={settings.catalog.masterColors}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
          displayCurrencies={settings.exchange.displayCurrencies}
        />

        <ProductBlocksEditor
          productId={product.id}
          blocks={editorBlocks}
          authors={authors}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
