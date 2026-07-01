'use client';

import { useRef, useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { uploadCmsSectionImageAction } from './form-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Кнопка загрузки изображения CMS-секции (ADR-018, находка 8 аудита).
 *
 * Образец — settings/_components/ImageUploadButton, но через CMS-экшен
 * uploadCmsSectionImageAction (cms.write), а не store-экшен. Загружает файл,
 * получает S3-ключ (cms/<uuid>.webp, ключ генерит сервер) и отдаёт его через
 * onUploaded — вызывающая форма кладёт ключ в своё поле секции и сохраняет.
 *
 * Виджет НЕ ослабляет серверную валидацию: вся проверка (magic-bytes,
 * webp-конверсия, assertCmsEnabled, право) — внутри Server Action; здесь мы лишь
 * передаём байты файла через FormData.
 */
export function CmsImageUploadButton({
  label = 'Загрузить файл',
  onUploaded,
}: {
  label?: string;
  onUploaded: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending(true);
    setError(null);
    setDone(false);
    const fd = new FormData();
    fd.set('file', file);
    const res = await uploadCmsSectionImageAction(fd);
    setPending(false);
    if (inputRef.current) inputRef.current.value = '';
    if (res.ok) {
      onUploaded(res.data.key);
      setDone(true);
    } else {
      setError(errorMessage(res as Fail));
    }
  }

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={onChange}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Загрузка…' : label}
      </button>
      {done ? (
        <span className="ml-2 text-xs text-green-700">
          ✓ файл загружен, ключ подставлен в поле
        </span>
      ) : null}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
