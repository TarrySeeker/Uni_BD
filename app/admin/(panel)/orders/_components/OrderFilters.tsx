'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_TYPES,
} from '@/lib/orders/types';
import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryTypeLabel,
} from '@/lib/admin/order-format';

/**
 * Панель фильтров списка заказов (docs/07 §5). Состояние живёт в URL (shareable):
 * поиск (номер/email/телефон), статус заказа, статус оплаты, тип доставки, период
 * дат, промокод. Сабмит формирует querystring и навигирует — серверная страница
 * перечитывает заказы. Сброс на первую страницу при изменении фильтров.
 */
export function OrderFilters() {
  const router = useRouter();
  const params = useSearchParams();

  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [paymentStatus, setPaymentStatus] = useState(params.get('paymentStatus') ?? '');
  const [deliveryType, setDeliveryType] = useState(params.get('deliveryType') ?? '');
  const [promoCode, setPromoCode] = useState(params.get('promoCode') ?? '');
  const [dateFrom, setDateFrom] = useState(params.get('dateFrom') ?? '');
  const [dateTo, setDateTo] = useState(params.get('dateTo') ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (status) next.set('status', status);
    if (paymentStatus) next.set('paymentStatus', paymentStatus);
    if (deliveryType) next.set('deliveryType', deliveryType);
    if (promoCode.trim()) next.set('promoCode', promoCode.trim());
    if (dateFrom) next.set('dateFrom', dateFrom);
    if (dateTo) next.set('dateTo', dateTo);
    router.push(`/admin/orders${next.toString() ? `?${next.toString()}` : ''}`);
  }

  function reset() {
    setQ('');
    setStatus('');
    setPaymentStatus('');
    setDeliveryType('');
    setPromoCode('');
    setDateFrom('');
    setDateTo('');
    router.push('/admin/orders');
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
      aria-label="Фильтры заказов"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="of-q" className="block text-xs font-medium text-gray-600">
            Поиск (номер / email / телефон)
          </label>
          <input
            id="of-q"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Например: 2026-000123 или почта"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="of-status" className="block text-xs font-medium text-gray-600">
            Статус заказа
          </label>
          <select
            id="of-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любой</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {orderStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="of-payment" className="block text-xs font-medium text-gray-600">
            Статус оплаты
          </label>
          <select
            id="of-payment"
            value={paymentStatus}
            onChange={(e) => setPaymentStatus(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любой</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {paymentStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="of-delivery" className="block text-xs font-medium text-gray-600">
            Тип доставки
          </label>
          <select
            id="of-delivery"
            value={deliveryType}
            onChange={(e) => setDeliveryType(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Любой</option>
            {DELIVERY_TYPES.map((t) => (
              <option key={t} value={t}>
                {deliveryTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="of-promo" className="block text-xs font-medium text-gray-600">
            Промокод
          </label>
          <input
            id="of-promo"
            type="text"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            placeholder="Код промокода"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="of-from" className="block text-xs font-medium text-gray-600">
            Дата с
          </label>
          <input
            id="of-from"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="of-to" className="block text-xs font-medium text-gray-600">
            Дата по
          </label>
          <input
            id="of-to"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
        >
          Сбросить
        </button>
        <button
          type="submit"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Применить
        </button>
      </div>
    </form>
  );
}
