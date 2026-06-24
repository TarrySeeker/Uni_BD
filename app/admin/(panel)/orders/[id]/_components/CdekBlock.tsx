'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import { errorMessage } from '../../_components/action-result';

import {
  createCdekShipmentAction,
  cancelCdekShipmentAction,
  refreshCdekStatusAction,
  getCdekLabelAction,
} from './cdek-actions';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Сериализуемый снимок отправления для клиента (даты — строки). */
export interface CdekShipmentView {
  id: string;
  cdekUuid: string | null;
  cdekNumber: string | null;
  statusCode: string | null;
  statusName: string | null;
  statusAt: string | null;
  pvzCode: string | null;
  deliveryMode: string | null;
  printUrl: string | null;
  isMock: boolean;
  error: string | null;
}

/** Одна запись истории статусов для клиента. */
export interface CdekStatusLogView {
  id: string;
  statusCode: string;
  statusName: string | null;
  cityName: string | null;
  receivedAt: string;
  isMock: boolean;
}

/** Ссылка на отслеживание СДЭК по трек-номеру. */
function trackUrl(cdekNumber: string): string {
  return `https://www.cdek.ru/ru/tracking?order_id=${encodeURIComponent(cdekNumber)}`;
}

/**
 * Блок СДЭК в карточке заказа (docs/08 §10.2).
 *
 * Показывает текущее отправление (статус/трек/ПВЗ), историю событий webhook и
 * кнопки управления: «Создать отправление» (если ещё нет), «Обновить статус»,
 * «Печать накладной»/«Печать ШК» (открывают полученный URL), «Отменить
 * отправление». Право cdek.manage проверяется на сервере внутри каждого действия;
 * этот компонент рисуется только когда у пользователя есть право (гейт в page.tsx).
 */
export function CdekBlock({
  orderId,
  shipment,
  history,
  deliveryType,
  paymentReady,
}: {
  orderId: string;
  shipment: CdekShipmentView | null;
  history: CdekStatusLogView[];
  deliveryType: string;
  /**
   * Поступила ли оплата (FF.md): накладную формируем ТОЛЬКО после оплаты. Если
   * false — кнопку создания скрываем и поясняем, что отправление появится после
   * оплаты (сервер всё равно отклонит преждевременное создание — двойная защита).
   */
  paymentReady: boolean;
}) {
  const router = useRouter();

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const hasShipment = Boolean(shipment?.cdekUuid);
  const isPickup = deliveryType === 'pickup';

  async function run(
    label: string,
    fn: () => Promise<ActionResult<unknown>>,
    opts: { confirm?: string; openUrl?: boolean } = {},
  ) {
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await fn();
    setPending(false);
    if (result.ok) {
      if (
        opts.openUrl &&
        result.data &&
        typeof (result.data as { url?: unknown }).url === 'string'
      ) {
        window.open((result.data as { url: string }).url, '_blank', 'noopener');
      }
      setSuccess(`${label}: выполнено.`);
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-4"
      aria-label="Доставка СДЭК"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-800">Доставка СДЭК</h2>
        {shipment?.isMock ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
            mock
          </span>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700"
        >
          {success}
        </div>
      ) : null}

      {isPickup ? (
        <p className="mt-3 text-sm text-gray-500">
          Самовывоз — отправление СДЭК не создаётся.
        </p>
      ) : (
        <>
          {/* --- Сведения об отправлении --- */}
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Статус</dt>
              <dd className="text-right text-gray-900">
                {shipment?.statusName ?? shipment?.statusCode ?? '— нет отправления —'}
              </dd>
            </div>
            {shipment?.cdekNumber ? (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Трек</dt>
                <dd className="text-right">
                  <a
                    href={trackUrl(shipment.cdekNumber)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 hover:underline"
                  >
                    {shipment.cdekNumber}
                  </a>
                </dd>
              </div>
            ) : null}
            {shipment?.pvzCode ? (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">ПВЗ</dt>
                <dd className="text-right text-gray-900">{shipment.pvzCode}</dd>
              </div>
            ) : null}
            {shipment?.error ? (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Ошибка</dt>
                <dd className="text-right text-red-600">{shipment.error}</dd>
              </div>
            ) : null}
          </dl>

          {/* Накладная — только после оплаты (FF.md). Пока оплата не поступила,
              кнопку создания не показываем, поясняем автоматику. */}
          {!hasShipment && !paymentReady ? (
            <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Отправление СДЭК и накладная создаются <strong>после поступления оплаты</strong> —
              автоматически, без ручных действий. Так заказ не уедет неоплаченным.
            </p>
          ) : null}

          {/* --- Кнопки управления --- */}
          <div className="mt-4 flex flex-wrap gap-2">
            {!hasShipment && paymentReady ? (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run('Создание отправления', () => createCdekShipmentAction({ orderId }))
                }
                className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                Создать отправление
              </button>
            ) : null}
            {hasShipment ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run('Обновление статуса', () => refreshCdekStatusAction({ orderId }))
                  }
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  Обновить статус
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Печать накладной',
                      () => getCdekLabelAction({ orderId, kind: 'waybill' }),
                      { openUrl: true },
                    )
                  }
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  Печать накладной
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Печать ШК',
                      () => getCdekLabelAction({ orderId, kind: 'barcode' }),
                      { openUrl: true },
                    )
                  }
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  Печать ШК
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      'Отмена отправления',
                      () => cancelCdekShipmentAction({ orderId }),
                      { confirm: 'Отменить отправление СДЭК?' },
                    )
                  }
                  className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Отменить отправление
                </button>
              </>
            ) : null}
          </div>

          {/* --- История событий webhook --- */}
          {history.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                История статусов СДЭК
              </h3>
              <ul className="mt-2 divide-y divide-gray-100">
                {history.map((h) => (
                  <li key={h.id} className="py-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-gray-700">
                        {h.statusName ?? h.statusCode}
                      </span>
                      {h.cityName ? (
                        <span className="text-xs text-gray-400">{h.cityName}</span>
                      ) : null}
                      <span className="ml-auto text-xs text-gray-400">
                        {new Date(h.receivedAt).toLocaleString('ru-RU')}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
