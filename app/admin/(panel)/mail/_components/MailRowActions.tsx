'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { resendMailAction } from './mail-actions';
import { errorMessage } from '../../orders/_components/action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Действие над строкой журнала писем: «Отправить повторно».
 *
 * Подтверждение обязательно и НЕ формальность: письмо может нести код
 * подарочного сертификата — деньги на предъявителя. Случайный клик отправил бы
 * его повторно, а покупатель решил бы, что кодов у него два.
 *
 * Письма, не привязанные к заказу, переслать нельзя (тело пересобирается из
 * заказа — см. lib/mail/resend.ts), поэтому для них кнопка не показывается: это
 * честнее, чем кнопка, которая гарантированно вернёт ошибку.
 *
 * Ошибки — inline под строкой (паттерн SubscriberRowActions/PromoRowActions).
 */
export function MailRowActions({
  id,
  recipient,
  resendable,
}: {
  id: string;
  recipient: string;
  resendable: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  if (!resendable) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  async function onResend() {
    if (!window.confirm(t('mail.rowActions.confirmResend', { recipient }))) return;
    setPending(true);
    setError(null);
    const result = await resendMailAction({ id });
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onResend}
        className="rounded-md border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
      >
        {t('mail.rowActions.resend')}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {errorMessage(error, t)}
        </span>
      ) : null}
    </div>
  );
}
