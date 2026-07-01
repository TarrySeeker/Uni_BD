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
  /** Зарезервировано под незавершённые заказы (anti-oversell). */
  reserved: number;
  /** Доступно к продаже = max(quantity − reserved, 0). */
  available: number;
}

export function InventorySection({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Собираем юниты: товар без вариантов (variantId null) + каждый вариант.
  // Строка inventory склада main несёт quantity (физический остаток) и reserved
  // (резерв под незавершённые заказы); доступно к продаже = quantity − reserved.
  function invFor(variantId: string | null): { quantity: number; reserved: number } {
    const inv = product.inventory.find(
      (i) => (i.variantId ?? null) === variantId && i.warehouseCode === 'main',
    );
    return { quantity: inv?.quantity ?? 0, reserved: inv?.reserved ?? 0 };
  }

  function unitFor(
    key: string,
    label: string,
    variantId: string | null,
  ): Unit {
    const { quantity, reserved } = invFor(variantId);
    return {
      key,
      label,
      variantId,
      quantity,
      reserved,
      available: Math.max(quantity - reserved, 0),
    };
  }

  const units: Unit[] =
    product.variants.length === 0
      ? [unitFor('product', 'Товар (без вариантов)', null)]
      : product.variants.map((v) =>
          unitFor(v.id, `${v.sku}${v.name ? ` — ${v.name}` : ''}`, v.id),
        );

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
      <p className="mt-1 text-xs text-gray-500">
        Редактируется физический остаток. При оформлении заказа товар уходит в
        резерв (столбец «Зарезервировано») и списывается с остатка только при
        отгрузке — поэтому «Доступно» = остаток − резерв.
      </p>
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
              <th scope="col" className="px-3 py-2 font-medium" title="Физический остаток на складе">
                Физический остаток
              </th>
              <th scope="col" className="px-3 py-2 font-medium" title="Зарезервировано под незавершённые заказы">
                Зарезервировано
              </th>
              <th scope="col" className="px-3 py-2 font-medium" title="Доступно к продаже = физический остаток − зарезервировано">
                Доступно
              </th>
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
                <td className="px-3 py-2 text-gray-700">{u.reserved}</td>
                <td
                  className="px-3 py-2 font-medium text-gray-900"
                  title="Физический остаток − зарезервировано"
                >
                  {u.available}
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
