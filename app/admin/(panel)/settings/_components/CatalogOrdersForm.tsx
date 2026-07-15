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
 * freeDeliveryThreshold и цены зон вводятся в РУБЛЯХ; на сервере конвертируются в
 * копейки. Текущие значения приходят в копейках → показываем в рублях (fromMinor).
 *
 * Зоны доставки (ТЗ_1) — универсальный (мультитенант) редактор: строки {название,
 * цена ₽, опц. порог бесплатной доставки ₽}. id зоны стабилен: у существующих
 * строк сохраняется, у новых генерируется из названия на сервере (slugify).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Строка редактора зоны в состоянии формы (цены — строки в рублях для input). */
interface ZoneRow {
  /** Стабильный id зоны; пусто у новой строки (сервер сгенерит из label). */
  id: string;
  label: string;
  priceRub: string;
  freeThresholdRub: string;
}

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
  // Зоны: копейки → рубли для отображения; пустой порог → '' (не задан).
  const [zones, setZones] = useState<ZoneRow[]>(
    delivery.zones.map((z) => ({
      id: z.id,
      label: z.label,
      priceRub: fromMinor(z.price),
      freeThresholdRub: z.freeThreshold !== undefined ? fromMinor(z.freeThreshold) : '',
    })),
  );

  function updateZone(index: number, patch: Partial<ZoneRow>) {
    setZones((prev) => prev.map((z, i) => (i === index ? { ...z, ...patch } : z)));
  }
  function addZone() {
    setZones((prev) => [...prev, { id: '', label: '', priceRub: '0', freeThresholdRub: '' }]);
  }
  function removeZone(index: number) {
    setZones((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    // Отправляем ПОЛНОЕ состояние зон (value ключа delivery пишется целиком):
    // пустые строки (без названия) отбрасываем; freeThreshold шлём, только если задан.
    const zonesPayload = zones
      .filter((z) => z.label.trim())
      .map((z) => ({
        ...(z.id.trim() ? { id: z.id.trim() } : {}),
        label: z.label.trim(),
        price: z.priceRub.trim() || '0',
        ...(z.freeThresholdRub.trim() ? { freeThreshold: z.freeThresholdRub.trim() } : {}),
      }));
    const result = await updateCatalogOrdersAction({
      catalog: newProductDays.trim() ? { newProductDays: Number(newProductDays) } : undefined,
      delivery: { freeDeliveryThreshold: freeThresholdRub.trim() || '0', zones: zonesPayload },
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

      {/* Зоны доставки (ТЗ_1): цена доставки по зоне, редактируется магазином. */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-900">Зоны доставки</h3>
            <p className="mt-1 text-xs text-gray-500">
              Цена доставки для выбранной покупателем зоны. Порог — необязательный: сумма заказа,
              с которой доставка в эту зону бесплатна.
            </p>
          </div>
          <button type="button" onClick={addZone}
            className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            + Добавить зону
          </button>
        </div>

        {zones.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">Зоны не заданы — используется обычный расчёт доставки.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {zones.map((z, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded border border-gray-200 p-3 sm:grid-cols-[1fr,8rem,8rem,auto] sm:items-end">
                <div>
                  <label htmlFor={`zone-label-${i}`} className="block text-xs font-medium text-gray-600">
                    Название
                  </label>
                  <input id={`zone-label-${i}`} value={z.label}
                    onChange={(e) => updateZone(i, { label: e.target.value })}
                    placeholder="например В пределах МКАД"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label htmlFor={`zone-price-${i}`} className="block text-xs font-medium text-gray-600">
                    Цена (₽)
                  </label>
                  <input id={`zone-price-${i}`} value={z.priceRub}
                    onChange={(e) => updateZone(i, { priceRub: e.target.value })}
                    placeholder="0"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label htmlFor={`zone-free-${i}`} className="block text-xs font-medium text-gray-600">
                    Порог ₽ (опц.)
                  </label>
                  <input id={`zone-free-${i}`} value={z.freeThresholdRub}
                    onChange={(e) => updateZone(i, { freeThresholdRub: e.target.value })}
                    placeholder="—"
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <button type="button" onClick={() => removeZone(i)}
                  className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
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
