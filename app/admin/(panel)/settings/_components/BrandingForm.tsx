'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';
import type { TranslationsMap } from '@/lib/i18n';

import { updateBrandingAction, uploadSettingsImageAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { SettingsTranslationTabs } from './SettingsTranslationTabs';
import { BRANDING_TR_FIELD_DEFS } from './content-i18n-form-state';

/**
 * Форма брендинга (docs/11 §5.4.5): название, логотип, favicon, цвета темы,
 * контакты поддержки. Мутация — updateBrandingSettings (settings.manage).
 * Пустые поля отправляются как undefined (не оверрайдим — падаем на env).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Локальный загрузчик изображения настроек (находка 19 аудита): грузит файл через
 * uploadSettingsImageAction с указанием kind (logo|favicon|og), который сам
 * валидирует magic-bytes, конвертирует в webp, кладёт в S3 и ПИШЕТ значение в
 * настройки (для logo/favicon — URL, для og — ключ). Возвращённое значение
 * подставляем в видимое поле через onUploaded, чтобы форма и поле остались
 * согласованными. Виджет inline (а не общий ImageUploadButton), т.к. тот
 * возвращает только S3-ключ и не годится для URL-полей логотипа/favicon.
 */
export function SettingsImageUpload({
  kind,
  label,
  onUploaded,
}: {
  kind: 'logo' | 'favicon' | 'og';
  label?: string;
  onUploaded: (value: string) => void;
}) {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending(true);
    setErr(null);
    setDone(false);
    const fd = new FormData();
    fd.set('kind', kind);
    fd.set('file', file);
    const res = (await uploadSettingsImageAction(fd)) as ActionResult<{ value: string }>;
    setPending(false);
    if (inputRef.current) inputRef.current.value = '';
    if (res.ok) {
      onUploaded(res.data.value);
      setDone(true);
    } else {
      setErr(errorMessage(res as Fail, t));
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
        {pending ? t('settings.brandingForm.uploading') : (label ?? t('settings.brandingForm.uploadFileDefault'))}
      </button>
      {done ? (
        <span className="ml-2 text-xs text-green-700">{t('settings.brandingForm.uploadDone')}</span>
      ) : null}
      {err ? <p className="mt-1 text-xs text-red-600">{err}</p> : null}
    </div>
  );
}

export function BrandingForm({
  branding,
  timeZone,
  i18n,
  translations,
}: {
  branding: EffectiveSettings['branding'];
  /**
   * Эффективный часовой пояс магазина (аудит major №26): настройка → env →
   * дефолт платформы. Приходит отдельным пропом, а не полем branding, потому что
   * резолвер живёт в lib/admin/timezone.ts и знает про env-приоритет.
   */
  timeZone: string;
  i18n: { defaultLocale: string; locales: string[] };
  translations?: TranslationsMap;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [shopName, setShopName] = useState(branding.shopName);
  const [logoUrl, setLogoUrl] = useState(branding.logoUrl ?? '');
  const [faviconUrl, setFaviconUrl] = useState(branding.faviconUrl ?? '');
  const [primaryColor, setPrimaryColor] = useState(branding.theme.primaryColor ?? '');
  const [accentColor, setAccentColor] = useState(branding.theme.accentColor ?? '');
  const [mode, setMode] = useState(branding.theme.mode);
  const [supportEmail, setSupportEmail] = useState(branding.supportEmail ?? '');
  const [supportPhone, setSupportPhone] = useState(branding.supportPhone ?? '');
  // Пояс, в котором оператору показывается ВСЁ время в админке (аудит major №26):
  // журнал аудита, список заказов, карточка; в нём же считаются сутки для фильтра
  // «за период». Мультитенантность: значение магазина, а не хардкод Москвы.
  const [tz, setTz] = useState(timeZone);

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const theme: Record<string, unknown> = { mode };
    if (primaryColor.trim()) theme.primaryColor = primaryColor.trim();
    if (accentColor.trim()) theme.accentColor = accentColor.trim();
    const result = await updateBrandingAction({
      branding: {
        shopName: shopName.trim() || undefined,
        logoUrl: logoUrl.trim() || undefined,
        faviconUrl: faviconUrl.trim() || undefined,
        theme,
        supportEmail: supportEmail.trim() || undefined,
        supportPhone: supportPhone.trim() || undefined,
        timeZone: tz.trim() || undefined,
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.brandingForm.saved'));
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, `branding.${f}`) ?? fieldError(error, f);

  return (
    <SettingsTranslationTabs
      section="branding"
      fields={BRANDING_TR_FIELD_DEFS}
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="s-name" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.shopName')}</label>
          <input id="s-name" value={shopName} onChange={(e) => setShopName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('shopName') ? <p className="mt-1 text-xs text-red-600">{fe('shopName')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-logo" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.logo')}</label>
          <input id="s-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)}
            placeholder={t('settings.brandingForm.urlOrUploadPlaceholder')} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <SettingsImageUpload kind="logo" label={t('settings.brandingForm.uploadLogo')} onUploaded={setLogoUrl} />
          {fe('logoUrl') ? <p className="mt-1 text-xs text-red-600">{fe('logoUrl')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-favicon" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.favicon')}</label>
          <input id="s-favicon" value={faviconUrl} onChange={(e) => setFaviconUrl(e.target.value)}
            placeholder={t('settings.brandingForm.urlOrUploadPlaceholder')} className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <SettingsImageUpload kind="favicon" label={t('settings.brandingForm.uploadFavicon')} onUploaded={setFaviconUrl} />
        </div>
        <div>
          <label htmlFor="s-mode" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.theme')}</label>
          <select id="s-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="system">{t('settings.brandingForm.themeSystem')}</option>
            <option value="light">{t('settings.brandingForm.themeLight')}</option>
            <option value="dark">{t('settings.brandingForm.themeDark')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="s-primary" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.primaryColor')}</label>
          <input id="s-primary" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
            placeholder="#1a1a1a" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fieldError(error, 'branding.theme') ? (
            <p className="mt-1 text-xs text-red-600">{fieldError(error, 'branding.theme')}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="s-accent" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.accentColor')}</label>
          <input id="s-accent" value={accentColor} onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#ff0000" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="s-semail" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.supportEmail')}</label>
          <input id="s-semail" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('supportEmail') ? <p className="mt-1 text-xs text-red-600">{fe('supportEmail')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-sphone" className="block text-sm font-medium text-gray-700">{t('settings.brandingForm.supportPhone')}</label>
          <input id="s-sphone" value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="s-tz" className="block text-sm font-medium text-gray-700">
            {t('settings.brandingForm.timeZone')}
          </label>
          <input id="s-tz" value={tz} onChange={(e) => setTz(e.target.value)}
            placeholder="Europe/Moscow"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('timeZone') ? <p className="mt-1 text-xs text-red-600">{fe('timeZone')}</p> : null}
          <p className="mt-1 text-xs text-gray-500">{t('settings.brandingForm.timeZoneHelp')}</p>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('settings.brandingForm.saveButton')}
        </button>
      </div>
    </div>
    </SettingsTranslationTabs>
  );
}
