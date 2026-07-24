'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { ProductDetail } from '@/lib/catalog/types';

import {
  uploadMediaAction,
  deleteMediaAction,
  reorderMediaAction,
} from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Секция «Медиа» (docs/05 §5.5). Загрузка файла (превью), список с выбором
 * главного и удалением. Все проверки (magic-bytes/тип/размер) — на сервере
 * (attachMedia → validateUpload); клиент лишь отправляет файл.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function MediaSection({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const t = useTranslations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);
  const [alt, setAlt] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError({ ok: false, error: 'validation', fieldErrors: { file: [t('catalog.common.chooseFile')] } });
      return;
    }
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set('file', file);
    fd.set('alt', alt);
    fd.set('isPrimary', isPrimary ? 'true' : 'false');
    const result = await uploadMediaAction(product.id, fd);
    setPending(false);
    if (result.ok) {
      setAlt('');
      setIsPrimary(false);
      if (fileRef.current) fileRef.current.value = '';
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function makePrimary(id: string) {
    setError(null);
    const order = product.media.map((m) => m.id);
    const result = await reorderMediaAction({ productId: product.id, order, primaryId: id });
    if (result.ok) router.refresh();
    else setError(result);
  }

  async function remove(id: string) {
    if (!window.confirm(t('catalog.media.confirmDelete'))) {
      return;
    }
    setError(null);
    const result = await deleteMediaAction({ id });
    if (result.ok) router.refresh();
    else setError(result);
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(error)}
          {error.fieldErrors?.file ? ` ${error.fieldErrors.file[0]}` : ''}
        </div>
      ) : null}

      {product.media.length === 0 ? (
        <p className="text-sm text-gray-500">{t('catalog.media.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {product.media.map((m) => (
            <li key={m.id} className="rounded border border-gray-200 p-2">
              {m.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.alt} className="h-28 w-full rounded object-cover" />
              ) : (
                <div className="flex h-28 w-full items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
                  {t('catalog.media.noPreview')}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-xs">
                {m.isPrimary ? (
                  <span className="font-medium text-green-700">{t('catalog.media.primary')}</span>
                ) : (
                  <button type="button" onClick={() => makePrimary(m.id)} className="text-blue-700 hover:underline">
                    {t('catalog.media.makePrimary')}
                  </button>
                )}
                <button type="button" onClick={() => remove(m.id)} className="text-red-600 hover:underline">
                  {t('catalog.media.removeInline')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h3 className="text-sm font-semibold text-gray-800">{t('catalog.media.uploadTitle')}</h3>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="m-file" className="block text-xs font-medium text-gray-600">{t('catalog.common.fileLabel')}</label>
            <input
              id="m-file"
              ref={fileRef}
              type="file"
              accept="image/*"
              className="mt-1 w-full text-sm"
            />
          </div>
          <div>
            <label htmlFor="m-alt" className="block text-xs font-medium text-gray-600">{t('catalog.media.altLabel')}</label>
            <input
              id="m-alt"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </div>
          <label className="flex items-end gap-2 pb-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            {t('catalog.media.makePrimary')}
          </label>
        </div>
        <button
          type="button"
          onClick={upload}
          disabled={pending}
          className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? t('catalog.media.uploading') : t('catalog.blocks.buttons.upload')}
        </button>
      </div>
    </div>
  );
}
