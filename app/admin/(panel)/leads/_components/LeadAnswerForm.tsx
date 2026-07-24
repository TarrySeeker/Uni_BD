'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { answerLeadAction } from './actions';
import { errorMessage } from './action-result';

/**
 * Инлайн-редактор ответа оператора на заявку (§9, ← b_os_feedback.answer).
 * Пишет leads.answer через answerLeadAction (право orders.write на сервере).
 * Пустой ответ снимает его (репозиторий нормализует '' → NULL). Компактный —
 * встраивается в строку таблицы «Заявки».
 */
export function LeadAnswerForm({ id, answer }: { id: string; answer: string | null }) {
  const router = useRouter();
  const t = useTranslations();
  const [value, setValue] = useState(answer ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    const result = await answerLeadAction({ id, answer: value.trim() });
    setPending(false);
    if (result.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(errorMessage(result));
    }
  }

  return (
    <div className="min-w-[16rem]">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        rows={2}
        placeholder={t('leads.leadAnswerForm.answerPlaceholder')}
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? t('common.form.saving') : t('leads.leadAnswerForm.saveAnswer')}
        </button>
        {saved ? <span className="text-xs text-green-600">{t('common.form.saved')}</span> : null}
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </div>
  );
}
