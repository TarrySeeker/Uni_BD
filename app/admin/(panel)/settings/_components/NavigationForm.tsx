'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';
import type { TranslationsMap } from '@/lib/i18n';

import { parseNavigationFormState, type NavFooterMetaInput } from '@/lib/settings/nav-form';
import { updateNavigationContentAction } from './form-actions';
import { errorMessage } from './action-result';
import { ResetSettingButton } from './ResetSettingButton';
import { SettingsTranslationTabs } from './SettingsTranslationTabs';
import { buildNavigationTrFieldDefs } from './content-i18n-form-state';

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
  i18n,
  translations,
}: {
  navigation: EffectiveSettings['navigation'];
  i18n: { defaultLocale: string; locales: string[] };
  translations?: TranslationsMap;
}) {
  const t = useTranslations();
  const router = useRouter();
  // Дескрипторы переводимых меток разворачиваются по фактической навигации
  // (пункты шапки + заголовки/ссылки колонок футера); href не переводится.
  const trFields = buildNavigationTrFieldDefs(navigation as unknown as Record<string, unknown>);
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [headerText, setHeaderText] = useState(headerToText(navigation.header));
  const [footerText, setFooterText] = useState(footerToText(navigation.footer));
  // Тексты подвала (эталон .footer-top__subscriptions + .footer-foot). Пустые
  // поля в настройки НЕ уходят — витрина берёт свой дефолт по локали.
  const [meta, setMeta] = useState<NavFooterMetaInput>({
    subscribeTitle: navigation.footerMeta?.subscribeTitle ?? '',
    subscribeNote: navigation.footerMeta?.subscribeNote ?? '',
    copyright: navigation.footerMeta?.copyright ?? '',
    designedByLabel: navigation.footerMeta?.designedByLabel ?? '',
    designedByHref: navigation.footerMeta?.designedByHref ?? '',
  });

  const setMetaField = (key: keyof NavFooterMetaInput) => (value: string) =>
    setMeta((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateNavigationContentAction({
      navigation: parseNavigationFormState(headerText, footerText, meta),
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.navigationForm.saved'));
      router.refresh();
    } else {
      setError(result);
    }
  }

  const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const hintCls = 'mt-1 text-xs text-gray-500';

  return (
    <SettingsTranslationTabs
      section="navigation"
      fields={trFields}
      locales={i18n.locales}
      defaultLocale={i18n.defaultLocale}
      translations={translations}
    >
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <p className="mb-5 text-sm text-gray-600">
        {t.rich('settings.navigationForm.intro', {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>

      {/* Меню шапки */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.navigationForm.headerLegend')}</legend>
        <div>
          <label htmlFor="nav-header" className={labelCls}>{t('settings.navigationForm.headerItemsLabel')}</label>
          <textarea id="nav-header" value={headerText} onChange={(e) => setHeaderText(e.target.value)}
            rows={5} className={inputCls} placeholder={t('settings.navigationForm.headerPlaceholder')} />
          <p className={hintCls}>
            {t.rich('settings.navigationForm.headerHint', {
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        </div>
      </fieldset>

      {/* Футер */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.navigationForm.footerLegend')}</legend>
        <div>
          <label htmlFor="nav-footer" className={labelCls}>
            {t('settings.navigationForm.footerColumnsLabel')}
          </label>
          <textarea id="nav-footer" value={footerText} onChange={(e) => setFooterText(e.target.value)}
            rows={8} className={inputCls}
            placeholder={t('settings.navigationForm.footerPlaceholder')} />
          <p className={hintCls}>{t('settings.navigationForm.footerHint')}</p>
        </div>
      </fieldset>

      {/* Тексты подвала: форма подписки + нижняя строка. Всё опционально —
          пустое поле означает «использовать текст по умолчанию». */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">
          {t('settings.navigationForm.footerTextsLegend')}
        </legend>
        <p className={`mb-4 ${hintCls}`}>{t('settings.navigationForm.footerTextsHint')}</p>

        <div className="mb-4">
          <label htmlFor="nav-subscribe-title" className={labelCls}>
            {t('settings.navigationForm.subscribeTitleLabel')}
          </label>
          <input
            id="nav-subscribe-title"
            type="text"
            value={meta.subscribeTitle ?? ''}
            onChange={(e) => setMetaField('subscribeTitle')(e.target.value)}
            className={inputCls}
          />
        </div>

        <div className="mb-4">
          <label htmlFor="nav-subscribe-note" className={labelCls}>
            {t('settings.navigationForm.subscribeNoteLabel')}
          </label>
          <textarea
            id="nav-subscribe-note"
            rows={2}
            value={meta.subscribeNote ?? ''}
            onChange={(e) => setMetaField('subscribeNote')(e.target.value)}
            className={inputCls}
          />
        </div>

        <div className="mb-4">
          <label htmlFor="nav-copyright" className={labelCls}>
            {t('settings.navigationForm.copyrightLabel')}
          </label>
          <input
            id="nav-copyright"
            type="text"
            value={meta.copyright ?? ''}
            onChange={(e) => setMetaField('copyright')(e.target.value)}
            className={inputCls}
          />
          <p className={hintCls}>{t('settings.navigationForm.copyrightHint')}</p>
        </div>

        <div className="mb-4">
          <label htmlFor="nav-designed-by" className={labelCls}>
            {t('settings.navigationForm.designedByLabel')}
          </label>
          <input
            id="nav-designed-by"
            type="text"
            value={meta.designedByLabel ?? ''}
            onChange={(e) => setMetaField('designedByLabel')(e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="nav-designed-by-href" className={labelCls}>
            {t('settings.navigationForm.designedByHrefLabel')}
          </label>
          <input
            id="nav-designed-by-href"
            type="text"
            value={meta.designedByHref ?? ''}
            onChange={(e) => setMetaField('designedByHref')(e.target.value)}
            className={inputCls}
          />
          <p className={hintCls}>{t('settings.navigationForm.designedByHrefHint')}</p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('settings.navigationForm.saveButton')}
        </button>
        <ResetSettingButton settingKey="navigation" label={t('settings.navigationForm.resetButton')} />
      </div>
    </div>
    </SettingsTranslationTabs>
  );
}
