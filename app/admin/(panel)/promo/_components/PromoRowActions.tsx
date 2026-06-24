'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import {
  deactivatePromoCodeAction,
  deletePromoCodeAction,
} from '../../orders/_components/order-actions';
import { errorMessage } from '../../orders/_components/action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Действия над строкой промокода в списке: деактивация (мягкое «удаление»,
 * is_active=false — история заказов не рушится) и полное удаление (DELETE,
 * snapshot orders.promo_code сохраняется). Оба — orders.write на сервере;
 * с подтверждением. Ошибки показываются inline под строкой.
 */
export function PromoRowActions({
  id,
  code,
  isActive,
}: {
  id: string;
  code: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  async function run(
    fn: () => Promise<ActionResult<unknown>>,
    confirmText: string,
  ) {
    if (!window.confirm(confirmText)) return;
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
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Link
          href={`/admin/promo/${id}`}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          Редактировать
        </Link>
        {isActive ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => deactivatePromoCodeAction({ id }),
                `Деактивировать промокод «${code}»? Он перестанет применяться, но останется в списке (включить обратно можно через «Редактировать»).`,
              )
            }
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
          >
            Деактивировать
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(
              () => deletePromoCodeAction({ id }),
              `Удалить промокод «${code}» безвозвратно? История заказов сохранится.`,
            )
          }
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Удалить
        </button>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {errorMessage(error)}
        </span>
      ) : null}
    </div>
  );
}
