'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';

import { setGiftStatusAction } from './form-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Управление одним сертификатом в строке таблицы (docs/24 §5): «Открыть»
 * (редактирование/история) + деактивация/реактивация (active↔disabled).
 * depleted/expired ставятся автоматически — вручную не трогаем. Право gift.write
 * проверяется на сервере внутри Server Action. После успеха — router.refresh().
 *
 * Показывается только при canWrite=true (для read-only права gift.read кнопок нет,
 * серверный гвард всё равно вторая защита).
 */
export function GiftRowActions({
  id,
  status,
  canWrite,
}: {
  id: string;
  status: string;
  canWrite: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);

  async function run(next: 'active' | 'disabled', confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setPending(true);
    setError(null);
    const result = await setGiftStatusAction({ id, status: next });
    setPending(false);
    if (result.ok) router.refresh();
    else setError(result);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/admin/gift-certificates/${id}`}
          className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
        >
          {t('giftCertificates.giftRowActions.open')}
        </Link>
        {canWrite && status === 'disabled' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run('active')}
            className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            title={t('giftCertificates.giftRowActions.activateTitle')}
          >
            {t('giftCertificates.giftRowActions.activate')}
          </button>
        ) : null}
        {canWrite && status !== 'disabled' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run('disabled', t('giftCertificates.giftRowActions.disableConfirm'))}
            className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            title={t('giftCertificates.giftRowActions.disableTitle')}
          >
            {t('giftCertificates.giftRowActions.disable')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-xs text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
    </div>
  );
}
