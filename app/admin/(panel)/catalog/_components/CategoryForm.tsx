'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import type { Category } from '@/lib/catalog/types';

import { updateCategoryAction } from './form-actions';
import { buildCategoryUpdateInput } from './category-payload';
import { errorMessage, fieldError } from './action-result';
import type { ActionResult } from '@/lib/server/action';
import { SeoFieldset, type SeoFieldsetValue } from '../../_components/SeoFieldset';
import {
  LocaleTabs,
  CATALOG_ENTITY_TR_FIELD_DEFS,
  toTranslationsState,
  translationsPayload,
  type TranslationsState,
} from '../../_components/LocaleTabs';

/**
 * Полная форма редактирования категории (тупик C13 — SEO/OG-поля категории были
 * недоступны в UI; единственный UI — дерево CategoryManager — правил только
 * name/parent). Зеркалит BrandForm: общий SeoFieldset (OG/canonical/noindex) +
 * описание + переключатель видимости. Мутация — updateCategory (catalog.write на
 * сервере); сборка payload — чистый маппер buildCategoryUpdateInput (покрыт юнитом).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function CategoryForm({
  category,
  locales,
  defaultLocale,
}: {
  category: Category;
  /** Включённые языки магазина (shop_settings.i18n.locales). */
  locales: readonly string[];
  /** Язык по умолчанию (база = обычные колонки). */
  defaultLocale: string;
}) {
  const router = useRouter();
  const t = useTranslations();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [translations, setTranslations] = useState<TranslationsState>(
    toTranslationsState(category.translations),
  );

  const [name, setName] = useState(category.name);
  const [slug, setSlug] = useState(category.slug);
  const [description, setDescription] = useState(category.description);
  const [imageKey, setImageKey] = useState(category.imageKey ?? '');
  const [isActive, setIsActive] = useState(category.isActive);
  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: category.seoTitle ?? '',
    seoDescription: category.seoDescription ?? '',
    ogTitle: category.ogTitle ?? '',
    ogDescription: category.ogDescription ?? '',
    ogImageKey: category.ogImageKey ?? '',
    canonicalUrl: category.canonicalUrl ?? '',
    noindex: category.noindex,
  });

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateCategoryAction({
      ...buildCategoryUpdateInput(category.id, { name, slug, description, isActive, imageKey, seo }),
      translations: translationsPayload(translations),
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('catalog.common.savedChanges'));
      router.refresh();
    } else {
      setError(result);
    }
  }

  function fe(f: string) {
    return fieldError(error, f);
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

      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        mode="edit"
        fields={CATALOG_ENTITY_TR_FIELD_DEFS}
        value={translations}
        onChange={setTranslations}
        pending={pending}
        onSave={save}
      >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="c-name" className="block text-sm font-medium text-gray-700">{t('fields.name')}*</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
          {fe('name') ? <p className="mt-1 text-xs text-red-600">{fe('name')}</p> : null}
        </div>
        <div>
          <label htmlFor="c-slug" className="block text-sm font-medium text-gray-700">{t('catalog.common.slugLabel')}</label>
          <input id="c-slug" value={slug} onChange={(e) => setSlug(e.target.value)}
            placeholder={t('catalog.common.slugAutoFromName')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="c-desc" className="block text-sm font-medium text-gray-700">{t('fields.description')}</label>
          <textarea id="c-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="c-image" className="block text-sm font-medium text-gray-700">
            {t('catalog.category.imageKeyLabel')}
          </label>
          <input id="c-image" value={imageKey} onChange={(e) => setImageKey(e.target.value)}
            placeholder={t('catalog.category.imageKeyPlaceholder')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-500">
            {t('catalog.category.imageKeyHelp')}
          </p>
          {fe('imageKey') ? <p className="mt-1 text-xs text-red-600">{fe('imageKey')}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          {t('catalog.category.showOnSiteLabel')}
        </label>
        <div className="lg:col-span-2">
          <SeoFieldset
            value={seo}
            onChange={setSeo}
            idPrefix="c-seo"
            canonicalPlaceholder={t('catalog.category.seoCanonicalPlaceholder', {
              slug: slug || t('catalog.category.slugFallback'),
            })}
            fieldErrors={{
              seoTitle: fieldError(error, 'seoTitle'),
              seoDescription: fieldError(error, 'seoDescription'),
              ogTitle: fieldError(error, 'ogTitle'),
              ogDescription: fieldError(error, 'ogDescription'),
              ogImageKey: fieldError(error, 'ogImageKey'),
              canonicalUrl: fieldError(error, 'canonicalUrl'),
            }}
          />
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending || !name.trim()}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('common.actions.save')}
        </button>
        <button type="button" onClick={() => router.push('/admin/catalog/categories')}
          className="text-sm text-gray-600 hover:underline">
          {t('common.actions.cancel')}
        </button>
      </div>
      </LocaleTabs>
    </div>
  );
}
