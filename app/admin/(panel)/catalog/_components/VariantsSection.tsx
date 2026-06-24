'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ProductDetail } from '@/lib/catalog/types';

import {
  createVariantAction,
  updateVariantAction,
  deleteVariantAction,
} from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Секция «Варианты» (docs/05 §5.3). Таблица вариантов товара + форма добавления.
 * Мутации — Server Actions createVariant/updateVariant/deleteVariant (catalog.write).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function VariantsSection({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newOverride, setNewOverride] = useState('');
  const [newDelta, setNewDelta] = useState('0');
  // Вес/габариты варианта (0018): пусто = берётся от товара → дефолт магазина.
  const [newWeight, setNewWeight] = useState('');
  const [newLength, setNewLength] = useState('');
  const [newWidth, setNewWidth] = useState('');
  const [newHeight, setNewHeight] = useState('');

  /** Пустая строка → null (наследует от товара); иначе целое ≥ 0. */
  const strToNum = (v: string): number | null => {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  async function addVariant() {
    setPending(true);
    setError(null);
    const result = await createVariantAction({
      productId: product.id,
      // Пустой артикул → undefined: сервер сгенерирует уникальный из названия.
      sku: newSku.trim() || undefined,
      name: newName.trim(),
      priceOverride: newOverride.trim() ? newOverride.trim() : null,
      priceDelta: newDelta.trim() || '0',
      weightG: strToNum(newWeight),
      lengthCm: strToNum(newLength),
      widthCm: strToNum(newWidth),
      heightCm: strToNum(newHeight),
    });
    setPending(false);
    if (result.ok) {
      setNewSku('');
      setNewName('');
      setNewOverride('');
      setNewDelta('0');
      setNewWeight('');
      setNewLength('');
      setNewWidth('');
      setNewHeight('');
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
    if (!window.confirm('Удалить вариант? Действие необратимо, остатки варианта будут потеряны.')) {
      return;
    }
    setError(null);
    const result = await deleteVariantAction({ id });
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
              <th scope="col" className="px-3 py-2 font-medium">Размер / название</th>
              <th scope="col" className="px-3 py-2 font-medium">Артикул</th>
              <th scope="col" className="px-3 py-2 font-medium">Своя цена</th>
              <th scope="col" className="px-3 py-2 font-medium">Доплата</th>
              <th scope="col" className="px-3 py-2 font-medium">Вес/габариты</th>
              <th scope="col" className="px-3 py-2 font-medium">Активен</th>
              <th scope="col" className="px-3 py-2 font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {product.variants.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-gray-400">
                  Вариантов пока нет.
                </td>
              </tr>
            ) : (
              product.variants.map((v) => (
                <tr key={v.id}>
                  <td className="px-3 py-2 text-gray-700">{v.name || '—'}</td>
                  <td className="px-3 py-2"><code className="text-xs">{v.sku}</code></td>
                  <td className="px-3 py-2 text-gray-700">{v.priceOverride ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{v.priceDelta}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {v.weightG !== null || v.lengthCm !== null || v.widthCm !== null || v.heightCm !== null
                      ? `${v.weightG ?? '—'} г / ${v.lengthCm ?? '—'}×${v.widthCm ?? '—'}×${v.heightCm ?? '—'} см`
                      : '—'}
                  </td>
                  <td className="px-3 py-2">{v.isActive ? 'да' : 'нет'}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => toggleActive(v.id, v.isActive)}
                        className="text-xs text-blue-700 hover:underline"
                      >
                        {v.isActive ? 'отключить' : 'включить'}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeVariant(v.id)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h3 className="text-sm font-semibold text-gray-800">Добавить вариант</h3>
        <p className="mt-1 text-xs text-gray-500">
          Вариант — это размер/цвет товара (напр. «48» или «M»). Укажите название и,
          при необходимости, свою цену. Остаток варианта задаётся в таблице ниже.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="v-name" className="block text-xs font-medium text-gray-600">Размер / название*</label>
            <input id="v-name" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="напр. 48, M, Красный"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-override" className="block text-xs font-medium text-gray-600">Своя цена</label>
            <input id="v-override" inputMode="decimal" value={newOverride} onChange={(e) => setNewOverride(e.target.value)}
              placeholder="пусто — как у товара"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-delta" className="block text-xs font-medium text-gray-600">Доплата к цене</label>
            <input id="v-delta" inputMode="decimal" value={newDelta} onChange={(e) => setNewDelta(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-sku" className="block text-xs font-medium text-gray-600">Артикул</label>
            <input id="v-sku" value={newSku} onChange={(e) => setNewSku(e.target.value)}
              placeholder="можно не заполнять"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Вес/габариты варианта (пусто — берётся от товара → дефолт магазина):
        </p>
        <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="v-weight" className="block text-xs font-medium text-gray-600">Вес (г)</label>
            <input id="v-weight" inputMode="numeric" value={newWeight} onChange={(e) => setNewWeight(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-length" className="block text-xs font-medium text-gray-600">Длина (см)</label>
            <input id="v-length" inputMode="numeric" value={newLength} onChange={(e) => setNewLength(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-width" className="block text-xs font-medium text-gray-600">Ширина (см)</label>
            <input id="v-width" inputMode="numeric" value={newWidth} onChange={(e) => setNewWidth(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="v-height" className="block text-xs font-medium text-gray-600">Высота (см)</label>
            <input id="v-height" inputMode="numeric" value={newHeight} onChange={(e) => setNewHeight(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
        </div>
        <button
          type="button"
          onClick={addVariant}
          disabled={pending || !newName.trim()}
          className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Добавление…' : 'Добавить вариант'}
        </button>
      </div>
    </div>
  );
}
