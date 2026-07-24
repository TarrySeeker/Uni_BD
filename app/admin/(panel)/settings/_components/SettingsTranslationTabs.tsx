'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { TranslationsMap } from '@/lib/i18n';
import { updateContentI18n } from '@/lib/settings/actions';

import {
  LocaleTabs,
  type TranslatableFieldDef,
  type TranslationsState,
} from '../../_components/LocaleTabs';
import { errorMessage } from './action-result';
import {
  initTrState,
  buildContentI18nSaves,
  type ContentI18nSection,
} from './content-i18n-form-state';

/**
 * Волна 5, трек C — обёртка редактора ПЕРЕВОДОВ секции настроек (ключ content_i18n).
 *
 * Оборачивает базовую форму (children) переключателем языков: вкладка основного
 * языка = базовая форма как есть (правит русские значения прежним путём); вкладки
 * не-дефолтных языков = пополевой ввод переводов whitelist-полей. Перевод уходит
 * в updateContentI18n(locale, section, patch) — ОТДЕЛЬНО от базового action формы,
 * поэтому сохранение базовых полей перевод не затирает (и наоборот).
 *
 * Набор языков (locales/defaultLocale) — из shop_settings.i18n ∩ whitelist (ru/en/
 * fr), приходит пропсами со страницы (обязательные, без дефолта-маски). Один язык
 * магазина → LocaleTabs сам показывает объяснение «переводить нечего» вместо вкладок.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function SettingsTranslationTabs({
  section,
  fields,
  locales,
  defaultLocale,
  translations,
  children,
}: {
  /** Секция настроек (совпадает с ключом внутри оверлея content_i18n). */
  section: ContentI18nSection;
  /** Переводимые поля секции (плоские или разложенные по путям массивов). */
  fields: readonly TranslatableFieldDef[];
  /** Включённые языки магазина (shop_settings.i18n ∩ whitelist). */
  locales: readonly string[];
  /** Язык по умолчанию (база = обычные значения ключей настроек). */
  defaultLocale: string;
  /** Сырой оверлей переводов настроек (shop_settings.content_i18n) для пре-заполнения. */
  translations?: TranslationsMap;
  /** Базовая форма (редактирование значений основного языка). */
  children: ReactNode;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [trState, setTrState] = useState<TranslationsState>(() =>
    initTrState(translations, section),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function saveTranslations() {
    setPending(true);
    setError(null);
    setSuccess(null);
    // По одному вызову на язык: секция заменяется патчем целиком, соседние языки/
    // секции не затрагиваются (инвариант updateContentI18n).
    for (const save of buildContentI18nSaves(section, trState)) {
      const res = (await updateContentI18n(save)) as ActionResult<unknown>;
      if (!res.ok) {
        setError(errorMessage(res as Fail));
        setPending(false);
        return;
      }
    }
    setPending(false);
    setSuccess(t('settings.settingsTranslationTabs.saved'));
    router.refresh();
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        fields={fields}
        value={trState}
        onChange={setTrState}
        mode="edit"
        pending={pending}
        onSave={saveTranslations}
      >
        {children}
      </LocaleTabs>
    </div>
  );
}
