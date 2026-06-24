'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';
import { fromMinor } from '@/lib/orders/money';

import { updateCatalogOrdersAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

/**
 * Форма каталог/доставка/заказы (docs/11 §5.4.5).
 * freeDeliveryThreshold вводится в РУБЛЯХ; на сервере конвертируется в копейки.
 * Текущее значение приходит в копейках → показываем в рублях через fromMinor.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function CatalogOrdersForm({
  catalog,
  delivery,
  orders,
}: {
  catalog: EffectiveSettings['catalog'];
  delivery: EffectiveSettings['delivery'];
  orders: EffectiveSettings['orders'];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [newProductDays, setNewProductDays] = useState(String(catalog.newProductDays));
  // Копейки → рубли для отображения (0 = выключен).
  const [freeThresholdRub, setFreeThresholdRub] = useState(
    delivery.freeDeliveryThreshold > 0 ? fromMinor(delivery.freeDeliveryThreshold) : '0',
  );
  const [orderPrefix, setOrderPrefix] = useState(orders.orderPrefix);

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateCatalogOrdersAction({
      catalog: newProductDays.trim() ? { newProductDays: Number(newProductDays) } : undefined,
      delivery: { freeDeliveryThreshold: freeThresholdRub.trim() || '0' },
      orders: { orderPrefix: orderPrefix.trim() },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Настройки сохранены.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, f);

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="co-newdays" className="block text-sm font-medium text-gray-700">
            «Новизна» товара (дней)
          </label>
          <input id="co-newdays" type="number" min={0} value={newProductDays}
            onChange={(e) => setNewProductDays(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('catalog.newProductDays') ? (
            <p className="mt-1 text-xs text-red-600">{fe('catalog.newProductDays')}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="co-free" className="block text-sm font-medium text-gray-700">
            Порог бесплатной доставки (₽)
          </label>
          <input id="co-free" value={freeThresholdRub} onChange={(e) => setFreeThresholdRub(e.target.value)}
            placeholder="0 = выключено"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('delivery.freeDeliveryThreshold') ? (
            <p className="mt-1 text-xs text-red-600">{fe('delivery.freeDeliveryThreshold')}</p>
          ) : null}
          <p className="mt-1 text-xs text-gray-500">Сумма заказа, с которой доставка бесплатна. 0 — бесплатной доставки нет.</p>
        </div>
        <div>
          <label htmlFor="co-prefix" className="block text-sm font-medium text-gray-700">
            Префикс номера заказа
          </label>
          <input id="co-prefix" value={orderPrefix} onChange={(e) => setOrderPrefix(e.target.value)}
            placeholder="например GA"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
