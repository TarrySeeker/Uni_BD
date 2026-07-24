'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import type { Locale, LocaleConfig } from '@/lib/i18n/types';

import { updateI18nAction } from './form-actions';
import { errorMessage } from './action-result';
import {
  buildLanguageOptions,
  buildI18nPayload,
  toggleLocale,
  addCustomLocale,
  localeLabel,
} from './languages-form-state';

/**
 * Форма «Языки магазина» (T3) — включение/выключение языков контента.
 *
 * Язык по умолчанию ПОКАЗАН, но ЗАБЛОКИРОВАН: базовые колонки таблиц хранят
 * контент именно на нём, поэтому смена без миграции данных объявила бы весь
 * существующий контент другим языком (и переставила бы адреса страниц витрины).
 * Сервер отклоняет такую попытку независимо от формы.
 *
 * Список языков берётся из справочника платформы (languages-form-state), а не
 * хардкодится под конкретный магазин; произвольный тег можно добавить вручную.
 * Вся логика состояния — в чистом модуле рядом (тесты без DOM).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function LanguagesForm({ config }: { config: LocaleConfig }) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [enabled, setEnabled] = useState<Locale[]>(() => [...config.locales]);
  const [customTag, setCustomTag] = useState('');

  // Язык по умолчанию — из настроек, состояние формы его НЕ меняет (канон данных).
  const defaultLocale = config.defaultLocale;
  const rows = buildLanguageOptions({ defaultLocale, locales: enabled });

  function onToggle(code: Locale, on: boolean) {
    setNotice(null);
    setEnabled((prev) => toggleLocale(prev, code, on, defaultLocale));
  }

  function onAddCustom() {
    const res = addCustomLocale(enabled, customTag);
    setEnabled(res.enabled);
    setNotice(res.ok ? null : (res.error ?? null));
    if (res.ok) setCustomTag('');
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const payload = buildI18nPayload({ defaultLocale, enabled });
    const result = await updateI18nAction({ i18n: payload });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.languagesForm.saveSuccess'));
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

      {/*
        Честное предупреждение об ограничении: витрина пока не читает этот набор
        (её список языков захардкожен), поэтому выключение языка НЕ убирает
        переключатель с сайта — контент просто показывается на языке по умолчанию.
        Убрать это ограничение — отдельная задача по витрине.
      */}
      <div role="note" className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <strong>{t('settings.languagesForm.storefrontNoticeTitle')}</strong>{' '}
        {t('settings.languagesForm.storefrontNoticeBody', { defaultLabel: localeLabel(defaultLocale) })}
      </div>

      <div className="mb-5 rounded border border-gray-200 bg-gray-50 p-3">
        <label htmlFor="defaultLocale" className="block text-sm font-medium text-gray-800">
          {t('settings.languagesForm.defaultLocaleLabel')}
        </label>
        <input
          id="defaultLocale"
          name="defaultLocale"
          value={`${localeLabel(defaultLocale)} (${defaultLocale})`}
          disabled
          readOnly
          className="mt-1 w-full max-w-sm cursor-not-allowed rounded border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-600"
        />
        <p className="mt-2 text-xs text-gray-600">
          {t('settings.languagesForm.defaultLocaleHelp')}
        </p>
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.code}
            className="flex items-center justify-between rounded border border-gray-200 p-3"
          >
            <div>
              <div className="text-sm font-medium text-gray-800">
                {row.label}{' '}
                <span className="text-xs font-normal text-gray-500">({row.code})</span>
              </div>
              {row.isDefault ? (
                <div className="text-xs text-gray-500">
                  {t('settings.languagesForm.defaultRowNote')}
                </div>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={row.isDefault}
                onChange={(e) => onToggle(row.code, e.target.checked)}
                aria-label={t('settings.languagesForm.localeToggleAria', { label: row.label })}
                className="h-4 w-4"
              />
              {row.enabled ? t('settings.languagesForm.enabledState') : t('settings.languagesForm.disabledState')}
            </label>
          </div>
        ))}
      </div>

      <div className="mt-5 border-t border-gray-200 pt-4">
        <label htmlFor="customLocale" className="block text-sm font-medium text-gray-800">
          {t('settings.languagesForm.addManualLabel')}
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id="customLocale"
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            placeholder={t('settings.languagesForm.customPlaceholder')}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={onAddCustom}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t('common.actions.add')}
          </button>
        </div>
        {notice ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {notice}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-gray-500">
          {t('settings.languagesForm.customHelp')}
        </p>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? t('common.form.saving') : t('settings.languagesForm.saveButton')}
        </button>
      </div>
    </div>
  );
}
