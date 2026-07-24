'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ProductDetail, ProductVariant } from '@/lib/catalog/types';

import {
  createVariantAction,
  updateVariantAction,
  deleteVariantAction,
  reorderVariantAction,
} from './form-actions';
import {
  buildVariantCreateInput,
  buildVariantUpdateInput,
  type VariantFormValues,
} from './variant-payload';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Секция «Варианты» (docs/05 §5.3). Таблица вариантов товара + форма добавления +
 * инлайн-редактирование (C2) и переупорядочивание (C12). Мутации — Server Actions
 * createVariant/updateVariant/deleteVariant/reorderVariant (catalog.write).
 *
 * Сборка payload форм — чистый модуль variant-payload (нормализация денег/габаритов
 * общая для добавления и редактирования, покрыта юнит-тестами).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls = 'w-full rounded border border-gray-300 px-2 py-1 text-sm';

/** Пустые строковые поля формы варианта. */
const EMPTY_FORM: VariantFormValues = {
  sku: '',
  name: '',
  priceOverride: '',
  priceDelta: '0',
  compareAtPrice: '',
  weight: '',
  length: '',
  width: '',
  height: '',
};

/** Предзаполнение формы редактирования значениями существующего варианта. */
function formFromVariant(v: ProductVariant): VariantFormValues {
  return {
    sku: v.sku,
    name: v.name,
    priceOverride: v.priceOverride ?? '',
    priceDelta: v.priceDelta ?? '0',
    compareAtPrice: v.compareAtPrice ?? '',
    weight: v.weightG != null ? String(v.weightG) : '',
    length: v.lengthCm != null ? String(v.lengthCm) : '',
    width: v.widthCm != null ? String(v.widthCm) : '',
    height: v.heightCm != null ? String(v.heightCm) : '',
  };
}

export function VariantsSection({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const t = useTranslations();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  // Форма добавления.
  const [form, setForm] = useState<VariantFormValues>(EMPTY_FORM);
  const setField = (k: keyof VariantFormValues, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Инлайн-редактирование: id редактируемой строки + её черновик.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<VariantFormValues>(EMPTY_FORM);
  const setEditField = (k: keyof VariantFormValues, v: string) =>
    setEditForm((f) => ({ ...f, [k]: v }));

  async function addVariant() {
    setPending(true);
    setError(null);
    // Нормализация (RU-запятая/пробел разрядов → каноничные деньги, пусто → null)
    // и сборка payload — в чистом маппере buildVariantCreateInput.
    const result = await createVariantAction(buildVariantCreateInput(product.id, form));
    setPending(false);
    if (result.ok) {
      setForm(EMPTY_FORM);
      router.refresh();
    } else {
      setError(result);
    }
  }

  function startEdit(v: ProductVariant) {
    setError(null);
    setEditingId(v.id);
    setEditForm(formFromVariant(v));
  }

  async function saveEdit() {
    if (!editingId) return;
    setPending(true);
    setError(null);
    const result = await updateVariantAction(buildVariantUpdateInput(editingId, editForm));
    setPending(false);
    if (result.ok) {
      setEditingId(null);
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function toggleActive(id: string, isActive: boolean) {
    setError(null);
    const result = await updateVariantAction({ id, isActive: !isActive });
    if (result.ok) router.refresh();
    else setError(result);
  }

  async function removeVariant(id: string) {
    if (!window.confirm(t('catalog.variants.confirms.delete'))) {
      return;
    }
    setError(null);
    const result = await deleteVariantAction({ id });
    if (result.ok) router.refresh();
    else setError(result);
  }

  /** Переставить вариант на позицию index+dir (вверх/вниз) и сохранить порядок. */
  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= product.variants.length) return;
    const order = product.variants.map((v) => v.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    setError(null);
    const result = await reorderVariantAction({ productId: product.id, order });
    if (result.ok) router.refresh();
    else setError(result);
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.variants.labels.nameCol')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.product.fields.sku')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.variants.labels.priceOverride')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.variants.labels.compareAtPrice')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.variants.labels.priceDelta')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('catalog.variants.labels.dimensionsCol')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('common.states.active')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('common.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {product.variants.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-gray-400">
                  {t('catalog.variants.empty')}
                </td>
              </tr>
            ) : (
              product.variants.map((v, index) =>
                editingId === v.id ? (
                  <tr key={v.id} className="bg-amber-50/40">
                    <td className="px-3 py-2">
                      <input aria-label={t('catalog.variants.labels.nameCol')} value={editForm.name}
                        onChange={(e) => setEditField('name', e.target.value)} className={inputCls} />
                    </td>
                    <td className="px-3 py-2">
                      <input aria-label={t('catalog.product.fields.sku')} value={editForm.sku}
                        onChange={(e) => setEditField('sku', e.target.value)} className={inputCls} />
                    </td>
                    <td className="px-3 py-2">
                      <input aria-label={t('catalog.variants.labels.priceOverride')} inputMode="decimal" value={editForm.priceOverride}
                        onChange={(e) => setEditField('priceOverride', e.target.value)} className={inputCls} />
                    </td>
                    <td className="px-3 py-2">
                      <input aria-label={t('catalog.variants.labels.compareAtPrice')} inputMode="decimal" value={editForm.compareAtPrice}
                        onChange={(e) => setEditField('compareAtPrice', e.target.value)} className={inputCls} />
                    </td>
                    <td className="px-3 py-2">
                      <input aria-label={t('catalog.variants.labels.priceDelta')} inputMode="decimal" value={editForm.priceDelta}
                        onChange={(e) => setEditField('priceDelta', e.target.value)} className={inputCls} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="grid grid-cols-4 gap-1">
                        <input aria-label={t('catalog.product.fields.weight')} inputMode="numeric" value={editForm.weight}
                          onChange={(e) => setEditField('weight', e.target.value)} placeholder={t('catalog.variants.placeholders.weightShort')} className={inputCls} />
                        <input aria-label={t('catalog.product.fields.length')} inputMode="numeric" value={editForm.length}
                          onChange={(e) => setEditField('length', e.target.value)} placeholder={t('catalog.variants.placeholders.lengthShort')} className={inputCls} />
                        <input aria-label={t('catalog.product.fields.width')} inputMode="numeric" value={editForm.width}
                          onChange={(e) => setEditField('width', e.target.value)} placeholder={t('catalog.variants.placeholders.widthShort')} className={inputCls} />
                        <input aria-label={t('catalog.product.fields.height')} inputMode="numeric" value={editForm.height}
                          onChange={(e) => setEditField('height', e.target.value)} placeholder={t('catalog.variants.placeholders.heightShort')} className={inputCls} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{v.isActive ? t('catalog.variants.yes') : t('catalog.variants.no')}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button type="button" onClick={() => void saveEdit()} disabled={pending || !editForm.name.trim()}
                          className="text-xs font-medium text-blue-700 hover:underline disabled:opacity-50">
                          {t('catalog.variants.buttons.saveInline')}
                        </button>
                        <button type="button" onClick={() => setEditingId(null)}
                          className="text-xs text-gray-500 hover:underline">
                          {t('catalog.variants.buttons.cancelInline')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={v.id}>
                    <td className="px-3 py-2 text-gray-700">{v.name || '—'}</td>
                    <td className="px-3 py-2"><code className="text-xs">{v.sku}</code></td>
                    <td className="px-3 py-2 text-gray-700">{v.priceOverride ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{v.compareAtPrice ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{v.priceDelta}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {v.weightG !== null || v.lengthCm !== null || v.widthCm !== null || v.heightCm !== null
                        ? t('catalog.variants.dimensionsValue', {
                            weight: v.weightG ?? '—',
                            length: v.lengthCm ?? '—',
                            width: v.widthCm ?? '—',
                            height: v.heightCm ?? '—',
                          })
                        : '—'}
                    </td>
                    <td className="px-3 py-2">{v.isActive ? t('catalog.variants.yes') : t('catalog.variants.no')}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                          title={t('catalog.variants.buttons.moveUpTitle')} aria-label={t('catalog.variants.aria.moveUp')}
                          className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30">
                          ↑
                        </button>
                        <button type="button" onClick={() => move(index, 1)} disabled={index === product.variants.length - 1}
                          title={t('catalog.variants.buttons.moveDownTitle')} aria-label={t('catalog.variants.aria.moveDown')}
                          className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30">
                          ↓
                        </button>
                        <button type="button" onClick={() => startEdit(v)}
                          className="text-xs text-gray-700 hover:underline">
                          {t('catalog.variants.buttons.editInline')}
                        </button>
                        <button type="button" onClick={() => toggleActive(v.id, v.isActive)}
                          className="text-xs text-blue-700 hover:underline">
                          {v.isActive ? t('catalog.variants.buttons.disable') : t('catalog.variants.buttons.enable')}
                        </button>
                        <button type="button" onClick={() => removeVariant(v.id)}
                          className="text-xs text-red-600 hover:underline">
                          {t('catalog.variants.buttons.deleteInline')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h3 className="text-sm font-semibold text-gray-800">{t('catalog.variants.addTitle')}</h3>
        <p className="mt-1 text-xs text-gray-500">
          {t('catalog.variants.help.intro')}
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="v-name" className="block text-xs font-medium text-gray-600">{t('catalog.variants.labels.nameCol')}*</label>
            <input id="v-name" value={form.name} onChange={(e) => setField('name', e.target.value)}
              placeholder={t('catalog.variants.placeholders.name')}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-override" className="block text-xs font-medium text-gray-600">{t('catalog.variants.labels.priceOverride')}</label>
            <input id="v-override" inputMode="decimal" value={form.priceOverride} onChange={(e) => setField('priceOverride', e.target.value)}
              placeholder={t('catalog.variants.placeholders.inheritProduct')}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-compare" className="block text-xs font-medium text-gray-600">{t('catalog.variants.labels.compareAtPrice')}</label>
            <input id="v-compare" inputMode="decimal" value={form.compareAtPrice} onChange={(e) => setField('compareAtPrice', e.target.value)}
              placeholder={t('catalog.variants.placeholders.inheritProduct')}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-delta" className="block text-xs font-medium text-gray-600">{t('catalog.variants.labels.priceDeltaForm')}</label>
            <input id="v-delta" inputMode="decimal" value={form.priceDelta} onChange={(e) => setField('priceDelta', e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-sku" className="block text-xs font-medium text-gray-600">{t('catalog.product.fields.sku')}</label>
            <input id="v-sku" value={form.sku} onChange={(e) => setField('sku', e.target.value)}
              placeholder={t('catalog.variants.placeholders.skuOptional')}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {t('catalog.variants.help.dimensions')}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="v-weight" className="block text-xs font-medium text-gray-600">{t('catalog.product.fields.weight')}</label>
            <input id="v-weight" inputMode="numeric" value={form.weight} onChange={(e) => setField('weight', e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-length" className="block text-xs font-medium text-gray-600">{t('catalog.product.fields.length')}</label>
            <input id="v-length" inputMode="numeric" value={form.length} onChange={(e) => setField('length', e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-width" className="block text-xs font-medium text-gray-600">{t('catalog.product.fields.width')}</label>
            <input id="v-width" inputMode="numeric" value={form.width} onChange={(e) => setField('width', e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-height" className="block text-xs font-medium text-gray-600">{t('catalog.product.fields.height')}</label>
            <input id="v-height" inputMode="numeric" value={form.height} onChange={(e) => setField('height', e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>
        <button
          type="button"
          onClick={addVariant}
          disabled={pending || !form.name.trim()}
          className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? t('catalog.variants.adding') : t('catalog.variants.addTitle')}
        </button>
      </div>
    </div>
  );
}
