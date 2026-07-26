'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { isRussianPhone } from '@/lib/orders/phone';
import type { ActionResult } from '@/lib/server/action';

import { errorMessage, fieldError } from '../../_components/action-result';
import { updateOrderContactAction } from '../../_components/order-actions';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Правка контактов покупателя и адреса доставки в карточке заказа
 * (аудит 2026-07-26, находка #8).
 *
 * Зачем форма вообще появилась: раньше правки полей заказа не существовало ни в
 * одном виде. Покупатель с городским номером «2223344» оплачивал заказ, а
 * «Создать отправление» падало на нормализации телефона СДЭК — и накладную было
 * не создать НИКОГДА. Оставалось вернуть деньги или править БД руками.
 *
 * Границы намеренно узкие: только контакты и адрес. Позиции, суммы и статусы —
 * снимок сделки, они правятся своими путями; стоимость доставки при смене города
 * НЕ пересчитывается (об этом предупреждаем прямо в форме), потому что заказ уже
 * оплачен на согласованную сумму.
 */
export function OrderContactForm({
  orderId,
  customerName,
  customerEmail,
  customerPhone,
  deliveryCity,
  deliveryAddress,
  requiresAddress,
  hasCdekShipment,
}: {
  orderId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  /** Курьерская доставка: без адреса отправление не создать. */
  requiresAddress: boolean;
  /** Накладная СДЭК уже создана — правка здесь её не меняет. */
  hasCdekShipment: boolean;
}) {
  const router = useRouter();
  const t = useTranslations();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [name, setName] = useState(customerName);
  const [email, setEmail] = useState(customerEmail);
  const [phone, setPhone] = useState(customerPhone);
  const [city, setCity] = useState(deliveryCity ?? '');
  const [address, setAddress] = useState(deliveryAddress ?? '');
  const [reason, setReason] = useState('');

  // Предупреждение, а НЕ запрет: магазин трёхъязычный, у иностранного покупателя
  // легальный номер, который СДЭК не примет — но самовывоз/зона доставки работают.
  const phoneUnusableForCdek = phone.trim().length > 0 && !isRussianPhone(phone);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateOrderContactAction({
      id: orderId,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      deliveryCity: city,
      deliveryAddress: address,
      reason: reason || undefined,
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('orders.orderContactForm.success'));
      setReason('');
      router.refresh();
    } else {
      setError(result);
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          {t('orders.orderContactForm.heading')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {t('orders.orderContactForm.heading')}
      </h3>
      <p className="mt-1 text-xs text-gray-500">{t('orders.orderContactForm.intro')}</p>

      {hasCdekShipment ? (
        <p role="status" className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {t('orders.orderContactForm.cdekShipmentWarning')}
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mt-2 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <Field
          id="oc-name"
          label={t('orders.orderContactForm.name')}
          value={name}
          onChange={setName}
          error={fieldError(error, 'customerName')}
        />
        <Field
          id="oc-email"
          label={t('orders.orderContactForm.email')}
          value={email}
          onChange={setEmail}
          error={fieldError(error, 'customerEmail')}
        />
        <Field
          id="oc-phone"
          label={t('orders.orderContactForm.phone')}
          value={phone}
          onChange={setPhone}
          error={fieldError(error, 'customerPhone')}
          hint={phoneUnusableForCdek ? t('orders.orderContactForm.phoneNotCdek') : undefined}
        />
        <Field
          id="oc-city"
          label={t('orders.orderContactForm.city')}
          value={city}
          onChange={setCity}
          error={fieldError(error, 'deliveryCity')}
        />
        <Field
          id="oc-address"
          label={
            requiresAddress
              ? t('orders.orderContactForm.addressRequired')
              : t('orders.orderContactForm.address')
          }
          value={address}
          onChange={setAddress}
          error={fieldError(error, 'deliveryAddress')}
        />
        <Field
          id="oc-reason"
          label={t('orders.orderContactForm.reason')}
          value={reason}
          onChange={setReason}
          error={fieldError(error, 'reason')}
        />
      </div>

      <p className="mt-2 text-xs text-gray-500">{t('orders.orderContactForm.deliveryCostNotice')}</p>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {t('orders.orderContactForm.submit')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          {t('orders.orderContactForm.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Поле формы с подписью, ошибкой валидации и необязательной подсказкой. */
function Field({
  id,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-600">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
      />
      {hint ? <p className="mt-1 text-xs text-amber-700">{hint}</p> : null}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
