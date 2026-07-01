'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { parseNavigationFormState } from '@/lib/settings/nav-form';
import { updateNavigationContentAction } from './form-actions';
import { errorMessage } from './action-result';
import { ResetSettingButton } from './ResetSettingButton';

/**
 * C6 — форма «Навигация» (меню шапки и колонки футера витрины, G-10/G-11).
 *
 * Зеркало HomeContentForm: useRouter + локальный pending + action-result-хелперы.
 * Текстовые поля парсятся чистым parseNavigationFormState (lib/settings/nav-form),
 * затем уходят в существующий updateNavigationContentAction (settings.manage →
 * navigationSchema → upsert 'navigation' → audit). Валидацию href выполняет Zod
 * на бэкенде — битый href вернётся ошибкой валидации.
 *
 * Пустые поля → {header:[],footer:[]}: витрина показывает навигацию по умолчанию
 * своего инстанса (мультитенантно, без хардкода под магазин).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Эффективная навигация → текст для textarea шапки. */
function headerToText(header: EffectiveSettings['navigation']['header']): string {
  return header.map((i) => `${i.label} | ${i.href}`).join('\n');
}

/** Эффективная навигация → текст для textarea футера (колонки через пустую строку). */
function footerToText(footer: EffectiveSettings['navigation']['footer']): string {
  return footer
    .map((col) => [col.title, ...col.links.map((l) => `${l.label} | ${l.href}`)].join('\n'))
    .join('\n\n');
}

export function NavigationForm({
  navigation,
}: {
  navigation: EffectiveSettings['navigation'];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [headerText, setHeaderText] = useState(headerToText(navigation.header));
  const [footerText, setFooterText] = useState(footerToText(navigation.footer));

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateNavigationContentAction({
      navigation: parseNavigationFormState(headerText, footerText),
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Навигация сохранена.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const hintCls = 'mt-1 text-xs text-gray-500';

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

      <p className="mb-5 text-sm text-gray-600">
        Меню шапки и колонки футера витрины. Пусто — витрина покажет навигацию по
        умолчанию. Адрес ссылки — путь от «/» (например <code>/catalog</code>) либо
        полный URL / <code>mailto:</code> / <code>tel:</code>.
      </p>

      {/* Меню шапки */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Меню шапки</legend>
        <div>
          <label htmlFor="nav-header" className={labelCls}>Пункты: «Метка | Ссылка» (по одному на строку)</label>
          <textarea id="nav-header" value={headerText} onChange={(e) => setHeaderText(e.target.value)}
            rows={5} className={inputCls} placeholder={'Каталог | /catalog\nДоставка | /#delivery\nКонтакты | /contacts'} />
          <p className={hintCls}>Например: <code>Каталог | /catalog</code></p>
        </div>
      </fieldset>

      {/* Футер */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Колонки футера</legend>
        <div>
          <label htmlFor="nav-footer" className={labelCls}>
            Колонки разделяются пустой строкой. Первая строка колонки — заголовок,
            далее «Метка | Ссылка»
          </label>
          <textarea id="nav-footer" value={footerText} onChange={(e) => setFooterText(e.target.value)}
            rows={8} className={inputCls}
            placeholder={'Магазин\nКаталог | /catalog\nДоставка | /#delivery\n\nСвязь\nПочта | mailto:info@example.com'} />
          <p className={hintCls}>Каждый блок до пустой строки — отдельная колонка футера.</p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить навигацию'}
        </button>
        <ResetSettingButton settingKey="navigation" label="Сбросить навигацию" />
      </div>
    </div>
  );
}
