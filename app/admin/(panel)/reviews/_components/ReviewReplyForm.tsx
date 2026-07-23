'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  LocaleTabs,
  toTranslationsState,
  translationsPayload,
  type TranslatableFieldDef,
  type TranslationsState,
} from '../../_components/LocaleTabs';
import type { ActionResult } from '@/lib/server/action';

import { replyToReviewAction } from './actions';
import { errorMessage } from './action-result';

/** Поле перевода ответа магазина (whitelist REVIEW_TRANSLATABLE_FIELDS = ['reply']). */
const REPLY_FIELD_DEFS: readonly TranslatableFieldDef[] = [
  { key: 'reply', label: 'Ответ магазина', kind: 'textarea' },
];

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Форма ответа магазина на отзыв (docs/24 §4). Базовый (ru) reply — textarea;
 * вкладки EN/FR (LocaleTabs) правят оверлей перевода reply. Отправляет
 * replyToReviewAction { id, reply, translations }. UGC-текст отзыва НЕ переводим —
 * панель переводов только для ответа магазина.
 *
 * Без права reviews.write форма read-only (сервер тоже валидирует — двойная защита).
 */
export function ReviewReplyForm({
  id,
  reply,
  translations,
  locales,
  defaultLocale,
  canWrite,
}: {
  id: string;
  reply: string | null;
  translations: Record<string, Record<string, unknown>> | null;
  locales: readonly string[];
  defaultLocale: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [baseReply, setBaseReply] = useState<string>(reply ?? '');
  const [tr, setTr] = useState<TranslationsState>(() =>
    toTranslationsState(translations),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Fail | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    const result = await replyToReviewAction({
      id,
      reply: baseReply.trim() === '' ? null : baseReply,
      translations: translationsPayload(tr),
    });
    setPending(false);
    if (result.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <div className="max-w-2xl">
      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        fields={REPLY_FIELD_DEFS}
        value={tr}
        onChange={setTr}
        mode="edit"
        pending={pending}
        onSave={save}
        disabled={!canWrite}
      >
        <div>
          <label
            htmlFor="review-reply"
            className="block text-sm font-medium text-gray-700"
          >
            Ответ магазина ({defaultLocale.toUpperCase()})
          </label>
          <textarea
            id="review-reply"
            value={baseReply}
            rows={4}
            disabled={!canWrite}
            onChange={(e) => setBaseReply(e.target.value)}
            placeholder="Публичный ответ на отзыв (виден на витрине)"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
          />
        </div>
      </LocaleTabs>

      {canWrite ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {pending ? 'Сохранение…' : 'Сохранить ответ'}
          </button>
          {saved ? (
            <span role="status" className="text-sm text-green-700">
              Сохранено.
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mt-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
    </div>
  );
}
