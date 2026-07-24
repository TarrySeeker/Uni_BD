'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  nextStatuses,
  detectStatusContradictions,
} from '@/lib/orders/status';
import type { OrderStatus, DeliveryStatus } from '@/lib/orders/types';
import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
} from '@/lib/admin/order-format';
import type { ActionResult } from '@/lib/server/action';

import {
  changeOrderStatusAction,
  cancelOrderAction,
  refundOrderAction,
  setPaymentStatusAction,
  setDeliveryStatusAction,
} from './order-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Клиентская панель управления статусами заказа (docs/07 §5, статус-машина §2.8).
 *
 * Рисует кнопки ТОЛЬКО допустимых переходов — список берётся из nextStatuses
 * (lib/orders/status.ts, единый источник истины; сервер валидирует тот же whitelist
 * через canTransition). Действия:
 *  - смена статуса заказа (changeOrderStatus) с полем комментария и подтверждением;
 *  - смена статуса оплаты (setPaymentStatus) и доставки (setDeliveryStatus);
 *  - «Отменить» (cancelOrder) и «Возврат» (refundOrder) с подтверждением.
 * Ошибки переходов показываются понятно (ActionResult error / OrderError.message).
 * Право orders.write проверяется на сервере внутри каждого Server Action.
 */
export function OrderActionsPanel({
  orderId,
  status,
  paymentStatus,
  deliveryStatus,
  giftWarnings = [],
}: {
  orderId: string;
  status: string;
  paymentStatus: string;
  deliveryStatus: string;
  /**
   * Готовые строки giftRefundWarnings (ТЗ п.11): что случится с выпущенными
   * сертификатами при возврате. Считает сервер — здесь только показ.
   */
  giftWarnings?: readonly string[];
}) {
  const router = useRouter();
  const t = useTranslations();

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [comment, setComment] = useState('');

  const orderNext = nextStatuses('order', status);
  const paymentNext = nextStatuses('payment', paymentStatus);
  const deliveryNext = nextStatuses('delivery', deliveryStatus);

  // Баг #4 (аудит тупиков): три статус-машины независимы. Авто-синхронизации нет
  // (оси ортогональны), но показываем оператору МЯГКУЮ подсказку об очевидных
  // противоречиях (например, заказ «Отгружен», а доставка «Ожидает») — не блокируя.
  const contradictions = detectStatusContradictions({
    orderStatus: status as OrderStatus,
    deliveryStatus: deliveryStatus as DeliveryStatus,
  });

  async function run(
    label: string,
    fn: () => Promise<ActionResult<unknown>>,
    confirmText?: string,
  ) {
    if (confirmText && !window.confirm(confirmText)) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await fn();
    setPending(false);
    if (result.ok) {
      setSuccess(t('orders.orderActionsPanel.actionDone', { label }));
      setComment('');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-4"
      aria-label={t('orders.orderActionsPanel.heading')}
    >
      <h2 className="text-sm font-semibold text-gray-800">{t('orders.orderActionsPanel.heading')}</h2>
      <p className="mt-1 text-xs text-gray-500">
        {t('orders.orderActionsPanel.intro')}
      </p>

      {contradictions.length > 0 ? (
        <div
          role="status"
          className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <p className="font-medium">{t('orders.orderActionsPanel.contradictionsTitle')}</p>
          <ul className="mt-1 list-disc pl-5">
            {contradictions.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {giftWarnings.length > 0 ? (
        <div
          role="status"
          className="mt-3 rounded border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900"
        >
          <p className="font-medium">{t('orders.orderActionsPanel.giftTitle')}</p>
          <ul className="mt-1 list-disc pl-5">
            {giftWarnings.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(error, t)}
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

      <div className="mt-3">
        <label htmlFor="oa-comment" className="block text-xs font-medium text-gray-600">
          {t('orders.orderActionsPanel.commentLabel')}
        </label>
        <input
          id="oa-comment"
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t('orders.orderActionsPanel.commentPlaceholder')}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>

      {/* --- Переходы статуса заказа --- */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('orders.orderActionsPanel.orderStatusHeading')}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {orderNext.length === 0 ? (
            <span className="text-sm text-gray-400">{t('orders.orderActionsPanel.terminalNoTransitions')}</span>
          ) : (
            orderNext.map((to) => {
              const isCancel = to === 'cancelled';
              const isRefund = to === 'refunded';
              return (
                <button
                  key={to}
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    isCancel
                      ? run(
                          t('orders.orderActionsPanel.labels.cancelOrder'),
                          () => cancelOrderAction({ id: orderId, reason: comment || undefined }),
                          t('orders.orderActionsPanel.confirmCancel'),
                        )
                      : isRefund
                        ? run(
                            t('orders.orderActionsPanel.labels.refund'),
                            () => refundOrderAction({ id: orderId, reason: comment || undefined }),
                            t('orders.orderActionsPanel.confirmRefund'),
                          )
                        : run(t('orders.orderActionsPanel.labels.changeStatus'), () =>
                            changeOrderStatusAction({
                              id: orderId,
                              to,
                              comment: comment || undefined,
                            }),
                          )
                  }
                  className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                    isCancel || isRefund
                      ? 'border border-red-300 text-red-700 hover:bg-red-50'
                      : 'bg-gray-900 text-white hover:bg-gray-700'
                  }`}
                >
                  {orderStatusLabel(to)}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* --- Переходы статуса оплаты --- */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('orders.orderActionsPanel.paymentStatusHeading')}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {paymentNext.length === 0 ? (
            <span className="text-sm text-gray-400">{t('orders.orderActionsPanel.noTransitions')}</span>
          ) : (
            paymentNext.map((to) => (
              <button
                key={to}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(t('orders.orderActionsPanel.labels.changePaymentStatus'), () =>
                    setPaymentStatusAction({ id: orderId, to, comment: comment || undefined }),
                  )
                }
                className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                {paymentStatusLabel(to)}
              </button>
            ))
          )}
        </div>
      </div>

      {/* --- Переходы статуса доставки --- */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('orders.orderActionsPanel.deliveryStatusHeading')}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {deliveryNext.length === 0 ? (
            <span className="text-sm text-gray-400">{t('orders.orderActionsPanel.noTransitions')}</span>
          ) : (
            deliveryNext.map((to) => (
              <button
                key={to}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(t('orders.orderActionsPanel.labels.changeDeliveryStatus'), () =>
                    setDeliveryStatusAction({ id: orderId, to, comment: comment || undefined }),
                  )
                }
                className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                {deliveryStatusLabel(to)}
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
