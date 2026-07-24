'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { nextReviewStatuses, reviewStatusLabel } from '@/lib/reviews/status';
import type { ActionResult } from '@/lib/server/action';

import { setReviewStatusAction, deleteReviewAdminAction } from './actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Клиентское управление одним отзывом в строке таблицы модерации (docs/24 §4).
 *
 * Рисует кнопки ТОЛЬКО допустимых переходов из текущего статуса (nextReviewStatuses,
 * единый источник истины; сервер валидирует тот же whitelist через
 * canReviewTransition). Плюс «Удалить» с подтверждением. Право reviews.write
 * проверяется на сервере внутри каждого Server Action. После успеха —
 * router.refresh() (страница force-dynamic).
 */
export function ReviewRowActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  const transitions = nextReviewStatuses(status);

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
          const isApprove = to === 'approved';
          return (
            <button
              key={to}
              type="button"
              disabled={pending}
              onClick={() => run(() => setReviewStatusAction({ id, status: to }))}
              className={`rounded px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                isApprove
                  ? 'bg-green-700 text-white hover:bg-green-600'
                  : 'border border-gray-300 text-gray-600 hover:bg-gray-100'
              }`}
              title={t('reviews.reviewRowActions.changeStatusTo', {
                status: reviewStatusLabel(to, t),
              })}
            >
              {reviewStatusLabel(to, t)}
            </button>
          );
        })}
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(
              () => deleteReviewAdminAction({ id }),
              t('reviews.reviewRowActions.confirmDelete'),
            )
          }
          className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          title={t('reviews.reviewRowActions.deleteTitle')}
        >
          {t('common.actions.delete')}
        </button>
      </div>
      {error ? (
        <div role="alert" className="text-xs text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
    </div>
  );
}
