'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ProductDetail } from '@/lib/catalog/types';

import { setInventoryAction } from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Секция «Остатки» (docs/05 §4.7). Ручное управление остатком на складе main
 * для товара (variantId NULL) и каждого варианта. Мутация — setInventory
 * (UPSERT, CHECK не даёт <0), право catalog.write.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

interface Unit {
  key: string;
  label: string;
  variantId: string | null;
  quantity: number;
}

export function InventorySection({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Собираем юниты: товар без вариантов (variantId null) + каждый вариант.
  function stockFor(variantId: string | null): number {
    const inv = product.inventory.find(
      (i) => (i.variantId ?? null) === variantId && i.warehouseCode === 'main',
    );
    return inv?.quantity ?? 0;
  }

  const units: Unit[] =
    product.variants.length === 0
      ? [{ key: 'product', label: 'Товар (без вариантов)', variantId: null, quantity: stockFor(null) }]
      : product.variants.map((v) => ({
          key: v.id,
          label: `${v.sku}${v.name ? ` — ${v.name}` : ''}`,
          variantId: v.id,
          quantity: stockFor(v.id),
        }));

  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(units.map((u) => [u.key, String(u.quantity)])),
  );

  async function save(unit: Unit) {
    setSavingKey(unit.key);
    setError(null);
    const qty = Number(draft[unit.key]);
    if (!Number.isInteger(qty) || qty < 0) {
      setError({ ok: false, error: 'validation', fieldErrors: {}, message: 'Остаток — целое ≥ 0.' });
      setSavingKey(null);
      return;
    }
    const result = await setInventoryAction({
      productId: product.id,
      variantId: unit.variantId,
      warehouseCode: 'main',
      quantity: qty,
    });
    setSavingKey(null);
    if (result.ok) router.refresh();
    else setError(result);
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-800">Остатки (склад main)</h3>
      {error ? (
        <div role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Юнит</th>
              <th scope="col" className="px-3 py-2 font-medium">Остаток</th>
              <th scope="col" className="px-3 py-2 font-medium">Действие</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {units.map((u) => (
              <tr key={u.key}>
                <td className="px-3 py-2 text-gray-700">{u.label}</td>
                <td className="px-3 py-2">
                  <label htmlFor={`inv-${u.key}`} className="sr-only">
                    Остаток для {u.label}
                  </label>
                  <input
                    id={`inv-${u.key}`}
                    type="number"
                    min={0}
                    value={draft[u.key] ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, [u.key]: e.target.value }))}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => save(u)}
                    disabled={savingKey === u.key}
                    className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                  >
                    {savingKey === u.key ? '…' : 'Сохранить'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
