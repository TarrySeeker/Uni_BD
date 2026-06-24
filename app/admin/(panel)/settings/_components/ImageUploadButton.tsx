'use client';

import { useRef, useState } from 'react';

import type { ActionResult } from '@/lib/server/action';

import { uploadStoreImageAction } from './form-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Кнопка загрузки изображения (ADR-018, G-05). Загружает файл через
 * uploadStoreImageAction (settings.manage; validateUpload→webp→S3) и отдаёт
 * полученный S3-ключ через onUploaded — вызывающая форма кладёт ключ в своё поле
 * и сохраняет его обычным сохранением. Сам по себе виджет ничего в настройки не
 * пишет. Превью не показываем (избегаем доменной конфигурации next/image в
 * админке) — подтверждаем загрузку и подставляем ключ в видимое поле.
 */
export function ImageUploadButton({
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
    const res = (await uploadStoreImageAction(fd)) as ActionResult<{ key: string; url: string }>;
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
      <input ref={inputRef} type="file" accept="image/*" onChange={onChange} className="hidden" />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Загрузка…' : label}
      </button>
      {done ? <span className="ml-2 text-xs text-green-700">✓ файл загружен, адрес подставлен в поле</span> : null}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
