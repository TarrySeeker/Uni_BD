'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  Brand,
  CategoryTreeNode,
  ProductDetail,
} from '@/lib/catalog/types';
import { PRODUCT_STATUSES, type ProductStatus } from '@/lib/catalog/types';
import { isPubliclyVisible } from '@/lib/catalog/visibility';
import type { ActionResult } from '@/lib/server/action';

import {
  createProductAction,
  updateProductAction,
  archiveProductAction,
  deleteProductAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { VariantsSection } from './VariantsSection';
import { AttributesSection } from './AttributesSection';
import { MediaSection } from './MediaSection';
import { InventorySection } from './InventorySection';
import type { Attribute, AttributeValue } from '@/lib/catalog/types';
import {
  SeoFieldset,
  type SeoFieldsetValue,
} from '../../_components/SeoFieldset';

/**
 * Форма товара (docs/05 §5.3, П4.2). Секции-вкладки:
 * Основное / Варианты / Характеристики / Медиа / SEO.
 *
 * «Основное» доступно и при создании, и при редактировании; прочие секции —
 * только для существующего товара (нужен id). Сабмит — Server Action
 * createProduct/updateProduct; ошибки валидации берутся из fieldErrors.
 */

type Section = 'main' | 'variants' | 'attributes' | 'media' | 'seo';

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Черновик — скрыт с сайта',
  active: 'Активен — виден на сайте',
  archived: 'В архиве — скрыт с сайта',
};

function flattenCategories(
  nodes: CategoryTreeNode[],
  depth = 0,
): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const node of nodes) {
    out.push({ id: node.id, label: `${'— '.repeat(depth)}${node.name}` });
    out.push(...flattenCategories(node.children, depth + 1));
  }
  return out;
}

type FailResult = Extract<ActionResult<unknown>, { ok: false }>;

export function ProductForm({
  product,
  brands,
  categoryTree,
  attributes,
  attributeValues = {},
}: {
  /** null → режим создания. */
  product: ProductDetail | null;
  brands: Brand[];
  categoryTree: CategoryTreeNode[];
  attributes: Attribute[];
  /** Значения словарей характеристик по attribute_id — для select-атрибутов. */
  attributeValues?: Record<string, AttributeValue[]>;
}) {
  const router = useRouter();
  const isEdit = product !== null;

  const [section, setSection] = useState<Section>('main');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FailResult | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Поля «Основное».
  const [sku, setSku] = useState(product?.sku ?? '');
  const [slug, setSlug] = useState(product?.slug ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'draft');
  const [basePrice, setBasePrice] = useState(product?.basePrice ?? '0');
  const [compareAtPrice, setCompareAtPrice] = useState(product?.compareAtPrice ?? '');
  const [brandId, setBrandId] = useState(product?.brandId ?? '');
  // Вес/габариты для СДЭК (0018): пустая строка = null (дефолт магазина).
  const numToStr = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const [weightG, setWeightG] = useState(numToStr(product?.weightG));
  const [lengthCm, setLengthCm] = useState(numToStr(product?.lengthCm));
  const [widthCm, setWidthCm] = useState(numToStr(product?.widthCm));
  const [heightCm, setHeightCm] = useState(numToStr(product?.heightCm));
  const [isFeatured, setIsFeatured] = useState(product?.isFeatured ?? false);
  // is_new — троичная логика: 'auto' (null) | 'yes' (true) | 'no' (false).
  const [isNewMode, setIsNewMode] = useState<'auto' | 'yes' | 'no'>(
    product?.isNew === null || product?.isNew === undefined
      ? 'auto'
      : product.isNew
        ? 'yes'
        : 'no',
  );
  // SEO-набор: seoTitle/seoDescription + расширенные OG/canonical/noindex (docs/11 §5.3).
  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: product?.seoTitle ?? '',
    seoDescription: product?.seoDescription ?? '',
    ogTitle: product?.ogTitle ?? '',
    ogDescription: product?.ogDescription ?? '',
    ogImageKey: product?.ogImageKey ?? '',
    canonicalUrl: product?.canonicalUrl ?? '',
    noindex: product?.noindex ?? false,
  });

  const initialCategoryIds = product?.categories.map((c) => c.categoryId) ?? [];
  const [categoryIds, setCategoryIds] = useState<string[]>(initialCategoryIds);
  const [primaryCategoryId, setPrimaryCategoryId] = useState<string>(
    product?.categories.find((c) => c.isPrimary)?.categoryId ?? '',
  );

  const categories = flattenCategories(categoryTree);

  function toggleCategory(id: string) {
    setCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function onSubmit() {
    setPending(true);
    setError(null);
    setSuccess(null);

    const isNew = isNewMode === 'auto' ? null : isNewMode === 'yes';
    // Пустая строка → null (дефолт магазина); иначе целое (Zod проверит ≥ 0).
    const strToNum = (v: string): number | null => {
      const t = v.trim();
      if (t === '') return null;
      const n = Number(t);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const payload = {
      // Пустой артикул/адрес → undefined (а не ''), иначе .optional()-схема
      // отклонит пустую строку («Too small»); сервер сгенерирует их сам.
      sku: sku.trim() || undefined,
      slug: slug.trim() || undefined,
      name: name.trim(),
      description,
      status,
      basePrice: basePrice.trim() || '0',
      compareAtPrice: compareAtPrice.trim() ? compareAtPrice.trim() : null,
      isFeatured,
      isNew,
      brandId: brandId || null,
      categoryIds,
      primaryCategoryId: primaryCategoryId || null,
      seoTitle: seo.seoTitle.trim() || undefined,
      seoDescription: seo.seoDescription.trim() || undefined,
      weightG: strToNum(weightG),
      lengthCm: strToNum(lengthCm),
      widthCm: strToNum(widthCm),
      heightCm: strToNum(heightCm),
    };

    // Расширенные SEO/OG-поля принимает только Update-схема (docs/11 §5.3.3).
    const seoExtra = {
      ogTitle: seo.ogTitle.trim() || undefined,
      ogDescription: seo.ogDescription.trim() || undefined,
      ogImageKey: seo.ogImageKey.trim() || undefined,
      canonicalUrl: seo.canonicalUrl.trim() || undefined,
      noindex: seo.noindex,
    };

    try {
      const result = isEdit
        ? await updateProductAction({ id: product!.id, ...payload, ...seoExtra })
        : await createProductAction(payload);

      if (result.ok) {
        if (isEdit) {
          setSuccess('Изменения сохранены.');
          router.refresh();
        } else {
          router.push(`/admin/catalog/products/${result.data.id}`);
        }
      } else {
        setError(result);
      }
    } catch {
      setError({ ok: false, error: 'internal' });
    } finally {
      setPending(false);
    }
  }

  // Снять товар с продажи (в архив) — товар исчезает с сайта, но сохраняется
  // в системе (можно вернуть, выбрав статус «Активен»). Существующий экшен
  // archiveProduct (status='archived'); не удаляет данные/историю заказов.
  async function onArchive() {
    if (!isEdit) return;
    const ok = window.confirm(
      'Снять товар с продажи? Он исчезнет с сайта, но останется в каталоге — позже можно вернуть, выбрав статус «Активен».',
    );
    if (!ok) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await archiveProductAction({ id: product!.id });
      if (result.ok) {
        setStatus('archived');
        setSuccess('Товар снят с продажи (в архиве) — на сайте больше не показывается.');
        router.refresh();
      } else {
        setError(result);
      }
    } catch {
      setError({ ok: false, error: 'internal' });
    } finally {
      setPending(false);
    }
  }

  // Удалить товар НАВСЕГДА (в отличие от «снять с продажи»). Дочерние данные
  // уходят каскадом; история заказов сохраняется (снимок позиции, ADR-010).
  async function onDelete() {
    if (!isEdit) return;
    const ok = window.confirm(
      'Удалить товар НАВСЕГДА? Это действие нельзя отменить: товар и его варианты/фото/остатки будут удалены. ' +
        'История заказов с этим товаром сохранится. Если нужно просто убрать с сайта — используйте «Снять с продажи».',
    );
    if (!ok) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await deleteProductAction({ id: product!.id });
      if (result.ok) {
        router.push('/admin/catalog');
      } else {
        setError(result);
      }
    } catch {
      setError({ ok: false, error: 'internal' });
    } finally {
      setPending(false);
    }
  }

  // Виден ли товар покупателям прямо сейчас.
  // ЕДИНЫЙ предикат видимости (lib/catalog/visibility): на витрине товар виден ⇔
  // статус «active» — РОВНО как фильтр Storefront API. Остаток и цена на видимость
  // НЕ влияют: активный товар с остатком 0 витрина ПОКАЗЫВАЕТ (с «Нет в наличии»).
  // Раньше индикатор требовал ещё цену>0 и остаток>0 → ложно писал «скрыт с сайта»
  // про товар, который на витрине ЕСТЬ (рассинхрон предиката).
  const priceNum = Number(String(basePrice).replace(',', '.'));
  const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
  const totalAvailable = (product?.inventory ?? []).reduce(
    (sum, i) => sum + Math.max(0, (i.quantity ?? 0) - (i.reserved ?? 0)),
    0,
  );
  const isLiveOnSite = isPubliclyVisible(status);
  // НЕ-блокирующие заметки: товар виден, но есть на что обратить внимание.
  const storefrontNotes: string[] = [];
  if (!hasPrice) storefrontNotes.push('Цена не задана — на витрине покажется как 0. Укажите цену.');
  if (isEdit && totalAvailable <= 0)
    storefrontNotes.push('На складе 0 — на витрине показывается «Нет в наличии» (кнопка покупки недоступна). Задайте остаток на вкладке «Варианты».');

  const tabs: Array<{ key: Section; label: string; editOnly?: boolean }> = [
    { key: 'main', label: 'Основное' },
    { key: 'variants', label: 'Варианты', editOnly: true },
    { key: 'attributes', label: 'Характеристики', editOnly: true },
    { key: 'media', label: 'Медиа', editOnly: true },
    { key: 'seo', label: 'SEO' },
  ];

  function fieldErr(f: string) {
    return fieldError(error, f);
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      {isEdit ? (
        isLiveOnSite ? (
          <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <p>
              ✓ Товар <strong>виден покупателям</strong> на сайте в каталоге.
            </p>
            {storefrontNotes.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-amber-800">
                {storefrontNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p>
              ⚠ Товар <strong>скрыт с сайта</strong>. Чтобы он появился в каталоге на витрине,
              выберите статус «Активен — виден на сайте».
            </p>
          </div>
        )
      ) : null}

      <div role="tablist" aria-label="Секции товара" className="flex flex-wrap gap-1 border-b border-gray-200">
        {tabs
          .filter((t) => isEdit || !t.editOnly)
          // «Характеристики» (доп. атрибуты) прячем, пока их нет в справочнике —
          // чтобы не загромождать форму неактуальной вкладкой для простого магазина.
          .filter((t) => !(t.key === 'attributes' && attributes.length === 0))
          .map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={section === t.key}
              onClick={() => setSection(t.key)}
              className={`px-4 py-2 text-sm font-medium ${
                section === t.key
                  ? 'border-b-2 border-gray-900 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      <div className="mt-6">
        {section === 'main' ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <label htmlFor="p-name" className="block text-sm font-medium text-gray-700">
                Название*
              </label>
              <input
                id="p-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                required
              />
              {fieldErr('name') ? <p className="mt-1 text-xs text-red-600">{fieldErr('name')}</p> : null}
            </div>

            <div>
              <label htmlFor="p-price" className="block text-sm font-medium text-gray-700">
                Цена*
              </label>
              <input
                id="p-price"
                inputMode="decimal"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              {fieldErr('basePrice') ? <p className="mt-1 text-xs text-red-600">{fieldErr('basePrice')}</p> : null}
            </div>

            <div>
              <label htmlFor="p-status" className="block text-sm font-medium text-gray-700">
                Статус
              </label>
              <select
                id="p-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ProductStatus)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                {PRODUCT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                «Активен» — товар виден на сайте. «Черновик» и «В архиве» — скрыт.
              </p>
            </div>

            <div className="lg:col-span-2">
              <label htmlFor="p-desc" className="block text-sm font-medium text-gray-700">
                Описание
              </label>
              <textarea
                id="p-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <fieldset className="lg:col-span-2">
              <legend className="text-sm font-medium text-gray-700">Категории</legend>
              {categories.length === 0 ? (
                <p className="mt-1 text-sm text-gray-500">
                  Категорий пока нет. Создайте их в разделе «Категории».
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {categories.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={categoryIds.includes(c.id)}
                        onChange={() => toggleCategory(c.id)}
                      />
                      <span>{c.label}</span>
                      {categoryIds.includes(c.id) ? (
                        <label className="ml-auto flex items-center gap-1 text-xs text-gray-500">
                          <input
                            type="radio"
                            name="primaryCategory"
                            checked={primaryCategoryId === c.id}
                            onChange={() => setPrimaryCategoryId(c.id)}
                          />
                          основная
                        </label>
                      ) : null}
                    </label>
                  ))}
                </div>
              )}
              {fieldErr('primaryCategoryId') ? (
                <p className="mt-1 text-xs text-red-600">{fieldErr('primaryCategoryId')}</p>
              ) : null}
            </fieldset>

            <details className="lg:col-span-2 rounded border border-gray-200 p-3">
              <summary className="cursor-pointer text-sm font-medium text-gray-700">
                Дополнительные настройки — необязательно
              </summary>

              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="p-sku" className="block text-sm font-medium text-gray-700">
                    Артикул
                  </label>
                  <input
                    id="p-sku"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="оставьте пустым — создастся автоматически"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Код товара для учёта. Можно не заполнять.
                  </p>
                  {fieldErr('sku') ? <p className="mt-1 text-xs text-red-600">{fieldErr('sku')}</p> : null}
                </div>

                <div>
                  <label htmlFor="p-slug" className="block text-sm font-medium text-gray-700">
                    Адрес страницы на сайте
                  </label>
                  <input
                    id="p-slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="оставьте пустым — создастся автоматически из названия"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Часть ссылки товара на витрине. Можно не заполнять.
                  </p>
                  {fieldErr('slug') ? <p className="mt-1 text-xs text-red-600">{fieldErr('slug')}</p> : null}
                </div>

                <div>
                  <label htmlFor="p-compare" className="block text-sm font-medium text-gray-700">
                    Цена до скидки («было»)
                  </label>
                  <input
                    id="p-compare"
                    inputMode="decimal"
                    value={compareAtPrice}
                    onChange={(e) => setCompareAtPrice(e.target.value)}
                    placeholder="оставьте пустым — без скидки"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                  {fieldErr('compareAtPrice') ? (
                    <p className="mt-1 text-xs text-red-600">{fieldErr('compareAtPrice')}</p>
                  ) : null}
                </div>

                <div>
                  <label htmlFor="p-brand" className="block text-sm font-medium text-gray-700">
                    Бренд
                  </label>
                  <select
                    id="p-brand"
                    value={brandId}
                    onChange={(e) => setBrandId(e.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">— без бренда —</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <fieldset className="mt-4 flex flex-col gap-2">
                <legend className="text-sm font-medium text-gray-700">Бейджи на витрине</legend>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={isFeatured}
                    onChange={(e) => setIsFeatured(e.target.checked)}
                  />
                  Рекомендуемый (хит продаж) — бейдж на витрине
                </label>
                <div className="flex items-center gap-2 text-sm text-gray-700">
                  <label htmlFor="p-isnew">Бейдж «Новинка»:</label>
                  <select
                    id="p-isnew"
                    value={isNewMode}
                    onChange={(e) => setIsNewMode(e.target.value as 'auto' | 'yes' | 'no')}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="auto">Авто (по дате)</option>
                    <option value="yes">Да</option>
                    <option value="no">Нет</option>
                  </select>
                </div>
              </fieldset>

              <div className="mt-4">
                <p className="text-sm font-medium text-gray-700">
                  Вес и габариты (для расчёта доставки)
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Пусто — берётся значение по умолчанию из настроек магазина. У каждого
                  варианта можно задать свои.
                </p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <label htmlFor="p-weight" className="block text-xs font-medium text-gray-600">
                      Вес (г)
                    </label>
                    <input
                      id="p-weight"
                      inputMode="numeric"
                      value={weightG}
                      onChange={(e) => setWeightG(e.target.value)}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    {fieldErr('weightG') ? <p className="mt-1 text-xs text-red-600">{fieldErr('weightG')}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="p-length" className="block text-xs font-medium text-gray-600">
                      Длина (см)
                    </label>
                    <input
                      id="p-length"
                      inputMode="numeric"
                      value={lengthCm}
                      onChange={(e) => setLengthCm(e.target.value)}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    {fieldErr('lengthCm') ? <p className="mt-1 text-xs text-red-600">{fieldErr('lengthCm')}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="p-width" className="block text-xs font-medium text-gray-600">
                      Ширина (см)
                    </label>
                    <input
                      id="p-width"
                      inputMode="numeric"
                      value={widthCm}
                      onChange={(e) => setWidthCm(e.target.value)}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    {fieldErr('widthCm') ? <p className="mt-1 text-xs text-red-600">{fieldErr('widthCm')}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="p-height" className="block text-xs font-medium text-gray-600">
                      Высота (см)
                    </label>
                    <input
                      id="p-height"
                      inputMode="numeric"
                      value={heightCm}
                      onChange={(e) => setHeightCm(e.target.value)}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                    />
                    {fieldErr('heightCm') ? <p className="mt-1 text-xs text-red-600">{fieldErr('heightCm')}</p> : null}
                  </div>
                </div>
              </div>
            </details>
          </div>
        ) : null}

        {section === 'seo' ? (
          <div className="grid grid-cols-1 gap-4">
            <SeoFieldset
              value={seo}
              onChange={setSeo}
              idPrefix="p-seo"
              canonicalPlaceholder={`Авто: /product/${slug || 'slug-товара'}`}
              fieldErrors={{
                seoTitle: fieldError(error, 'seoTitle'),
                seoDescription: fieldError(error, 'seoDescription'),
                ogTitle: fieldError(error, 'ogTitle'),
                ogDescription: fieldError(error, 'ogDescription'),
                ogImageKey: fieldError(error, 'ogImageKey'),
                canonicalUrl: fieldError(error, 'canonicalUrl'),
              }}
            />
            {!isEdit ? (
              <p className="text-sm text-gray-500">
                OG/canonical/noindex станут доступны после сохранения товара.
              </p>
            ) : null}
          </div>
        ) : null}

        {section === 'variants' && isEdit ? (
          <VariantsSection product={product!} />
        ) : null}
        {section === 'attributes' && isEdit ? (
          <AttributesSection
            product={product!}
            attributes={attributes}
            attributeValues={attributeValues}
          />
        ) : null}
        {section === 'media' && isEdit ? <MediaSection product={product!} /> : null}
      </div>

      {section === 'main' || section === 'seo' ? (
        <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={onSubmit}
            disabled={pending}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать товар'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/catalog')}
            className="text-sm text-gray-600 hover:underline"
          >
            Отмена
          </button>
          {isEdit ? (
            <div className="ml-auto flex items-center gap-2">
              {status !== 'archived' ? (
                <button
                  type="button"
                  onClick={onArchive}
                  disabled={pending}
                  className="rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                >
                  Снять с продажи
                </button>
              ) : null}
              <button
                type="button"
                onClick={onDelete}
                disabled={pending}
                className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Удалить навсегда
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {isEdit && section === 'variants' ? null : null}
      {isEdit ? <InventorySectionPlaceholder section={section} product={product!} /> : null}
    </div>
  );
}

/** Остатки показываем во вкладке «Варианты» рядом с вариантами. */
function InventorySectionPlaceholder({
  section,
  product,
}: {
  section: Section;
  product: ProductDetail;
}) {
  if (section !== 'variants') {
    return null;
  }
  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      <InventorySection product={product} />
    </div>
  );
}
