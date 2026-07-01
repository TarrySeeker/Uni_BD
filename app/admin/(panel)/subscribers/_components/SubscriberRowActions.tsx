'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { unsubscribeSubscriberAction } from './subscriber-actions';
import { errorMessage } from '../../orders/_components/action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Действие над строкой подписчика: «Отписать» (status='unsubscribed' на сервере,
 * право orders.write, с подтверждением). Для уже отписанных кнопка не
 * показывается. Ошибки — inline под строкой (паттерн PromoRowActions).
 */
export function SubscriberRowActions({
  id,
  email,
  status,
}: {
  id: string;
  email: string;
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  // Активным предлагаем отписку; для уже отписанных действий нет (терминально).
  if (status !== 'active') {
    return <span className="text-xs text-gray-400">—</span>;
  }

  async function onUnsubscribe() {
    if (!window.confirm(`Отписать «${email}» от рассылки?`)) return;
    setPending(true);
    setError(null);
    const result = await unsubscribeSubscriberAction({ id });
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
        onClick={onUnsubscribe}
        className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
      >
        Отписать
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {errorMessage(error)}
        </span>
      ) : null}
    </div>
  );
}
