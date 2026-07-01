'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { SettingKey } from '@/lib/settings/schemas';

import { resetSettingAction } from './form-actions';
import { errorMessage } from './action-result';

/**
 * C27 — переиспользуемая кнопка «Сбросить раздел к умолчаниям».
 *
 * Вызывает уже существующий, защищённый (settings.manage) и аудируемый
 * resetSettingAction({ key }) (lib/settings/action-factory → settings.reset):
 * удаляет строку-оверрайд shop_settings → раздел возвращается к env/дефолтам
 * инстанса. После успеха — router.refresh() (страница перечитает эффективные
 * значения). Подтверждение через window.confirm, чтобы случайно не снести
 * настройки.
 *
 * Мультитенантность: ключ из enum SETTING_KEYS, тенант резолвится на сервере из
 * сессии — никакого хардкода под конкретный магазин.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function ResetSettingButton({
  settingKey,
  label,
}: {
  settingKey: SettingKey;
  label?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function reset() {
    if (
      !window.confirm(
        'Сбросить раздел к значениям по умолчанию? Переопределения будут удалены.',
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await resetSettingAction({ key: settingKey });
    setPending(false);
    if (result.ok) {
      setSuccess('Сброшено к значениям по умолчанию.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <span className="inline-flex items-center gap-3">
      <button
        type="button"
        onClick={reset}
        disabled={pending}
        className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Сброс…' : (label ?? 'Сбросить к умолчаниям')}
      </button>
      {error ? (
        <span role="alert" className="text-sm text-red-700">
          {errorMessage(error)}
        </span>
      ) : null}
      {success ? (
        <span role="status" className="text-sm text-green-700">
          {success}
        </span>
      ) : null}
    </span>
  );
}
