'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { updateAccessAction } from './form-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Форма «Доступ» (B9): переключатель однопользовательского режима магазина.
 *
 * Когда режим включён — разделы «Пользователи» и «Роли» убираются из меню, прямой
 * заход по их URL показывает заглушку, а серверные действия управления
 * пользователями/ролями блокируются (двойная защита). Дефолт OFF — мультитенант-
 * ность: другие магазины платформы не затронуты без явного включения. Сохранение —
 * через Server Action под settings.manage (Zod → upsert access → invalidate → audit).
 */
export function AccessForm({ singleUserMode }: { singleUserMode: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(singleUserMode);
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateAccessAction({ access: { singleUserMode: value } });
    setPending(false);
    if (result.ok) {
      setSuccess('Режим доступа сохранён.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => setValue(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium text-gray-800">Однопользовательский режим</span>
          <span className="block text-xs text-gray-500">
            Скрыть и заблокировать разделы «Пользователи» и «Роли». Подходит магазину
            с единственным администратором: лишние разделы не мешают, а случайное
            создание второй учётной записи или роли исключено. По умолчанию выключено.
          </span>
        </span>
      </label>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Сохранение…' : 'Сохранить режим доступа'}
        </button>
      </div>
    </div>
  );
}
