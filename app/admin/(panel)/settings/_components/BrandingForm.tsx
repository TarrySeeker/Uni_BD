'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { updateBrandingAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

/**
 * Форма брендинга (docs/11 §5.4.5): название, логотип, favicon, цвета темы,
 * контакты поддержки. Мутация — updateBrandingSettings (settings.manage).
 * Пустые поля отправляются как undefined (не оверрайдим — падаем на env).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function BrandingForm({ branding }: { branding: EffectiveSettings['branding'] }) {
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
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Брендинг сохранён.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, `branding.${f}`) ?? fieldError(error, f);

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="s-name" className="block text-sm font-medium text-gray-700">Название магазина</label>
          <input id="s-name" value={shopName} onChange={(e) => setShopName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('shopName') ? <p className="mt-1 text-xs text-red-600">{fe('shopName')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-logo" className="block text-sm font-medium text-gray-700">URL логотипа</label>
          <input id="s-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('logoUrl') ? <p className="mt-1 text-xs text-red-600">{fe('logoUrl')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-favicon" className="block text-sm font-medium text-gray-700">URL favicon</label>
          <input id="s-favicon" value={faviconUrl} onChange={(e) => setFaviconUrl(e.target.value)}
            placeholder="https://…" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="s-mode" className="block text-sm font-medium text-gray-700">Тема</label>
          <select id="s-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="system">Системная</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </div>
        <div>
          <label htmlFor="s-primary" className="block text-sm font-medium text-gray-700">Основной цвет (HEX)</label>
          <input id="s-primary" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)}
            placeholder="#1a1a1a" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fieldError(error, 'branding.theme') ? (
            <p className="mt-1 text-xs text-red-600">{fieldError(error, 'branding.theme')}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="s-accent" className="block text-sm font-medium text-gray-700">Акцентный цвет (HEX)</label>
          <input id="s-accent" value={accentColor} onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#ff0000" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="s-semail" className="block text-sm font-medium text-gray-700">Email поддержки</label>
          <input id="s-semail" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('supportEmail') ? <p className="mt-1 text-xs text-red-600">{fe('supportEmail')}</p> : null}
        </div>
        <div>
          <label htmlFor="s-sphone" className="block text-sm font-medium text-gray-700">Телефон поддержки</label>
          <input id="s-sphone" value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить брендинг'}
        </button>
      </div>
    </div>
  );
}
