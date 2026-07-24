'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';
import type { TranslationsMap } from '@/lib/i18n';

import { updateShopSeoAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { SettingsImageUpload } from './BrandingForm';
import { SettingsTranslationTabs } from './SettingsTranslationTabs';
import { SEO_TR_FIELD_DEFS } from './content-i18n-form-state';

/**
 * Форма SEO-настроек магазина (docs/11 §5.3.5): site_name, site_url,
 * title_template, default_description, default_og_image (ключ S3), twitter_site,
 * robots_extra, чекбокс noindex_site (для staging). Мутация —
 * updateShopSeoSettings (settings.manage). title_template обязан содержать «%s».
 * Пустые поля → undefined (не оверрайдим — падаем на env-дефолт).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function SeoSettingsForm({
  seo,
  i18n,
  translations,
}: {
  seo: EffectiveSettings['seo'];
  i18n: { defaultLocale: string; locales: string[] };
  translations?: TranslationsMap;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [siteName, setSiteName] = useState(seo.site_name ?? '');
  const [siteUrl, setSiteUrl] = useState(seo.site_url ?? '');
  const [titleTemplate, setTitleTemplate] = useState(seo.title_template ?? '%s');
  const [defaultDescription, setDefaultDescription] = useState(seo.default_description ?? '');
  const [defaultOgImageKey, setDefaultOgImageKey] = useState(seo.default_og_image_key ?? '');
  const [twitterSite, setTwitterSite] = useState(seo.twitter_site ?? '');
  const [robotsExtra, setRobotsExtra] = useState(seo.robots_extra ?? '');
  const [noindexSite, setNoindexSite] = useState(seo.noindex_site);

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateShopSeoAction({
      seo: {
        site_name: siteName.trim() || undefined,
        site_url: siteUrl.trim() || undefined,
        title_template: titleTemplate.trim() || undefined,
        default_description: defaultDescription.trim() || undefined,
        default_og_image_key: defaultOgImageKey.trim() || undefined,
        twitter_site: twitterSite.trim() || undefined,
        robots_extra: robotsExtra.trim() || undefined,
        noindex_site: noindexSite,
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.seoSettingsForm.saved'));
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, `seo.${f}`) ?? fieldError(error, f);
  const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
  const labelCls = 'block text-sm font-medium text-gray-700';

  return (
    <SettingsTranslationTabs
      section="seo"
      fields={SEO_TR_FIELD_DEFS}
      locales={i18n.locales}
      defaultLocale={i18n.defaultLocale}
      translations={translations}
    >
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
          <label htmlFor="seo-name" className={labelCls}>{t('settings.seoSettingsForm.siteName')}</label>
          <input id="seo-name" value={siteName} onChange={(e) => setSiteName(e.target.value)} className={inputCls} />
          {fe('site_name') ? <p className="mt-1 text-xs text-red-600">{fe('site_name')}</p> : null}
        </div>
        <div>
          <label htmlFor="seo-url" className={labelCls}>{t('settings.seoSettingsForm.siteUrl')}</label>
          <input id="seo-url" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://shop.example" className={inputCls} />
          {fe('site_url') ? <p className="mt-1 text-xs text-red-600">{fe('site_url')}</p> : null}
        </div>
        <div>
          <label htmlFor="seo-tpl" className={labelCls}>{t('settings.seoSettingsForm.titleTemplate')}</label>
          <input id="seo-tpl" value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)}
            placeholder={t('settings.seoSettingsForm.titleTemplatePlaceholder')} className={inputCls} />
          <p className="mt-1 text-xs text-gray-500">
            {t.rich('settings.seoSettingsForm.titleTemplateHint', {
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
          {fe('title_template') ? <p className="mt-1 text-xs text-red-600">{fe('title_template')}</p> : null}
        </div>
        <div>
          <label htmlFor="seo-twitter" className={labelCls}>{t('settings.seoSettingsForm.twitterSite')}</label>
          <input id="seo-twitter" value={twitterSite} onChange={(e) => setTwitterSite(e.target.value)} className={inputCls} />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="seo-descr" className={labelCls}>{t('settings.seoSettingsForm.defaultDescription')}</label>
          <textarea id="seo-descr" value={defaultDescription} onChange={(e) => setDefaultDescription(e.target.value)}
            rows={2} className={inputCls} />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="seo-og" className={labelCls}>{t('settings.seoSettingsForm.defaultOgImage')}</label>
          <input id="seo-og" value={defaultOgImageKey} onChange={(e) => setDefaultOgImageKey(e.target.value)}
            placeholder={t('settings.seoSettingsForm.defaultOgImagePlaceholder')} className={inputCls} />
          <SettingsImageUpload kind="og" label={t('settings.seoSettingsForm.uploadImage')} onUploaded={setDefaultOgImageKey} />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="seo-robots" className={labelCls}>{t('settings.seoSettingsForm.robotsExtra')}</label>
          <textarea id="seo-robots" value={robotsExtra} onChange={(e) => setRobotsExtra(e.target.value)}
            rows={2} className={inputCls} />
        </div>
        <div className="lg:col-span-2">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={noindexSite} onChange={(e) => setNoindexSite(e.target.checked)} />
            {t('settings.seoSettingsForm.noindexSite')}
          </label>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('settings.seoSettingsForm.saveButton')}
        </button>
      </div>
    </div>
    </SettingsTranslationTabs>
  );
}
