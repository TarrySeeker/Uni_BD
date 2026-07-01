'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { nextLeadStatuses, leadStatusLabel } from '@/lib/leads/status';
import type { ActionResult } from '@/lib/server/action';

import { setLeadStatusAction, deleteLeadAction } from './actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Клиентское управление одной заявкой в строке таблицы (G-09).
 *
 * Рисует кнопки ТОЛЬКО допустимых переходов из текущего статуса — список берётся
 * из nextLeadStatuses (lib/leads/status, единый источник истины; сервер валидирует
 * тот же whitelist через canLeadTransition). Плюс кнопка «Удалить» с подтверждением.
 * Право orders.write проверяется на сервере внутри каждого Server Action.
 * После успеха — router.refresh() (read-your-own-writes; страница force-dynamic).
 */
export function LeadRowActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  const transitions = nextLeadStatuses(status);

  async function run(
    fn: () => Promise<ActionResult<unknown>>,
    confirmText?: string,
  ) {
    if (confirmText && !window.confirm(confirmText)) return;
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (result.ok) {
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {transitions.map((to) => {
          const isArchive = to === 'spam';
          return (
            <button
              key={to}
              type="button"
              disabled={pending}
              onClick={() => run(() => setLeadStatusAction({ id, status: to }))}
              className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                isArchive
                  ? 'border border-gray-300 text-gray-600 hover:bg-gray-100'
                  : 'bg-gray-900 text-white hover:bg-gray-700'
              }`}
              title={`Сменить статус на «${leadStatusLabel(to)}»`}
            >
              {leadStatusLabel(to)}
            </button>
          );
        })}
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(
              () => deleteLeadAction({ id }),
              'Удалить заявку без возможности восстановления?',
            )
          }
          className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          title="Удалить заявку"
        >
          Удалить
        </button>
      </div>
      {error ? (
        <div role="alert" className="text-xs text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
    </div>
  );
}
