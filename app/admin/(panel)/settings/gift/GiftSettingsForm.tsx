'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { errorMessage } from '../_components/action-result';
import { updateGiftSettingsAction } from './actions';
import {
  buildGiftPayload,
  giftFormStateFrom,
  GIFT_FORM_DEFAULTS,
  type GiftFormState,
} from './gift-form-state';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Форма «Подарочные сертификаты»: политика выпуска кода при покупке сертификата
 * (ТЗ владельца п.11). Вся конвертация значений — в чистых функциях
 * gift-form-state (они покрыты юнитами), здесь только разметка и вызов действия.
 */
export function GiftSettingsForm({ saved }: { saved: unknown }) {
  const router = useRouter();
  const [state, setState] = useState<GiftFormState>(() => giftFormStateFrom(saved));
  const [error, setError] = useState<Fail | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function patch(next: Partial<GiftFormState>) {
    setState((prev) => ({ ...prev, ...next }));
  }

  async function save() {
    setError(null);
    setLocalError(null);
    setSuccess(null);

    const payload = buildGiftPayload(state);
    if (!payload.ok) {
      setLocalError(payload.error);
      return;
    }

    setPending(true);
    const result = await updateGiftSettingsAction(payload.value);
    setPending(false);
    if (result.ok) {
      setSuccess('Настройки подарочных сертификатов сохранены.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div>
      {error || localError ? (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {localError ?? errorMessage(error!)}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700"
        >
          {success}
        </div>
      ) : null}

      <div className="space-y-6">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={state.autoIssue}
            onChange={(e) => patch({ autoIssue: e.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Создавать код автоматически при оплате
            </span>
            <span className="block text-xs text-gray-500">
              Когда покупатель оплатил заказ с подарочным сертификатом, код создаётся
              сам: попадает в раздел «Подарочные сертификаты» и показывается покупателю
              после оформления. Если выключить — код придётся выпускать вручную из
              карточки заказа.
            </span>
          </span>
        </label>

        <div>
          <label htmlFor="gift-valid-days" className="block text-sm font-medium text-gray-800">
            Сколько дней действует код
          </label>
          <input
            id="gift-valid-days"
            type="text"
            inputMode="numeric"
            value={state.validDaysText}
            onChange={(e) => patch({ validDaysText: e.target.value })}
            placeholder="Например, 365"
            className="mt-1 w-40 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Оставьте поле пустым — код будет бессрочным. Срок отсчитывается от дня
            выпуска кода.
          </p>
        </div>

        <div>
          <label htmlFor="gift-categories" className="block text-sm font-medium text-gray-800">
            Разделы каталога с подарочными сертификатами
          </label>
          <textarea
            id="gift-categories"
            rows={3}
            value={state.categorySlugsText}
            onChange={(e) => patch({ categorySlugsText: e.target.value })}
            placeholder={GIFT_FORM_DEFAULTS.categorySlugs.join(', ')}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Адреса разделов, как они выглядят в ссылке на сайте (то, что идёт после
            /catalog/). Через запятую или с новой строки. В момент оформления заказа
            товары из этих разделов помечаются в самом заказе как подарочные
            сертификаты, и позже код создаётся именно по этой пометке. Уже оформленные
            заказы не меняются: переименуете или удалите раздел — код всё равно
            выпустится, потому что пометка сохранена в заказе.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Если оставить поле пустым, по разделам помечать никто не будет. Коды всё
            равно создадутся для товаров, у которых признак подарочного сертификата
            задан в самой карточке товара. Полностью отключить выдачу кодов можно
            только галочкой «Создавать код автоматически при оплате» выше.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={state.allowIssueOnGiftPaidOrder}
            onChange={(e) => patch({ allowIssueOnGiftPaidOrder: e.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Создавать код, если заказ оплачен другим сертификатом
            </span>
            <span className="block text-xs text-gray-500">
              Покупатель может оплатить новый сертификат остатком старого — фактически
              обменять номинал. Выключите, если такой обмен в магазине не нужен.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Сохранение…' : 'Сохранить настройки сертификатов'}
        </button>
      </div>
    </div>
  );
}
