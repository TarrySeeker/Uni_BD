'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';

import { uploadNewsCoverAction } from './form-actions';
import { errorMessage } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Кнопка загрузки обложки новости (образец CmsImageUploadButton, но через
 * news-экшен uploadNewsCoverAction, permission news.write). Загружает файл,
 * получает S3-ключ (news/<uuid>.webp, генерит сервер) и отдаёт через onUploaded.
 * Виджет НЕ ослабляет серверную валидацию (magic-bytes/webp/право — в Server Action).
 */
export function NewsImageUploadButton({
  label,
  onUploaded,
}: {
  label?: string;
  onUploaded: (key: string) => void;
}) {
  const t = useTranslations();
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
    const res = await uploadNewsCoverAction(fd);
    setPending(false);
    if (inputRef.current) inputRef.current.value = '';
    if (res.ok) {
      onUploaded(res.data.key);
      setDone(true);
    } else {
      setError(errorMessage(res as Fail, t));
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
        {pending ? t('news.newsImageUploadButton.uploading') : (label ?? t('news.newsImageUploadButton.defaultLabel'))}
      </button>
      {done ? (
        <span className="ml-2 text-xs text-green-700">{t('news.newsImageUploadButton.done')}</span>
      ) : null}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
