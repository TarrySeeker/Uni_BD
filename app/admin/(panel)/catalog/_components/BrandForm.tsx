'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import type { Brand } from '@/lib/catalog/types';

import {
  createBrandAction,
  updateBrandAction,
  uploadBrandLogoAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';
import type { ActionResult } from '@/lib/server/action';
import { SeoFieldset, type SeoFieldsetValue } from '../../_components/SeoFieldset';

/**
 * Форма бренда (docs/06 §3.3, П4.4). Создание/редактирование + загрузка лого.
 * Мутации — createBrand/updateBrand/uploadBrandLogo (catalog.write на сервере).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Бренд для формы: доменный Brand + готовый logoUrl (резолвен на сервере из
 * logoKey через storage.url, как og:image) — для предпросмотра <img>. URL в
 * доменной модели не храним; null — лого нет.
 */
export type BrandFormBrand = Brand & { logoUrl?: string | null };

export function BrandForm({ brand }: { brand: BrandFormBrand | null }) {
  const router = useRouter();
  const isEdit = brand !== null;
  const fileRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [name, setName] = useState(brand?.name ?? '');
  const [slug, setSlug] = useState(brand?.slug ?? '');
  const [description, setDescription] = useState(brand?.description ?? '');
  const [isActive, setIsActive] = useState(brand?.isActive ?? true);
  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: brand?.seoTitle ?? '',
    seoDescription: brand?.seoDescription ?? '',
    ogTitle: brand?.ogTitle ?? '',
    ogDescription: brand?.ogDescription ?? '',
    ogImageKey: brand?.ogImageKey ?? '',
    canonicalUrl: brand?.canonicalUrl ?? '',
    noindex: brand?.noindex ?? false,
  });

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const payload = {
      name: name.trim(),
      slug: slug.trim() || undefined,
      description,
      isActive,
      seoTitle: seo.seoTitle.trim() || undefined,
      seoDescription: seo.seoDescription.trim() || undefined,
    };
    // Расширенные SEO/OG-поля принимает только Update-схема (docs/11 §5.3.3).
    const seoExtra = {
      ogTitle: seo.ogTitle.trim() || undefined,
      ogDescription: seo.ogDescription.trim() || undefined,
      ogImageKey: seo.ogImageKey.trim() || undefined,
      canonicalUrl: seo.canonicalUrl.trim() || undefined,
      noindex: seo.noindex,
    };
    const result = isEdit
      ? await updateBrandAction({ id: brand!.id, ...payload, ...seoExtra })
      : await createBrandAction(payload);
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Изменения сохранены.');
        router.refresh();
      } else {
        router.push(`/admin/catalog/brands/${result.data.id}`);
      }
    } else {
      setError(result);
    }
  }

  async function uploadLogo() {
    if (!isEdit) return;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError({ ok: false, error: 'validation', fieldErrors: { file: ['Выберите файл.'] } });
      return;
    }
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set('file', file);
    const result = await uploadBrandLogoAction(brand!.id, fd);
    setPending(false);
    if (result.ok) {
      setSuccess('Логотип загружен.');
      if (fileRef.current) fileRef.current.value = '';
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="b-name" className="block text-sm font-medium text-gray-700">Название*</label>
          <input id="b-name" value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
          {fe('name') ? <p className="mt-1 text-xs text-red-600">{fe('name')}</p> : null}
        </div>
        <div>
          <label htmlFor="b-slug" className="block text-sm font-medium text-gray-700">ЧПУ (slug)</label>
          <input id="b-slug" value={slug} onChange={(e) => setSlug(e.target.value)}
            placeholder="авто из названия"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="b-desc" className="block text-sm font-medium text-gray-700">Описание</label>
          <textarea id="b-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Активен
        </label>
        <div className="lg:col-span-2">
          <SeoFieldset
            value={seo}
            onChange={setSeo}
            idPrefix="b-seo"
            canonicalPlaceholder={`Авто: /brand/${slug || 'slug-бренда'}`}
            fieldErrors={{
              seoTitle: fieldError(error, 'seoTitle'),
              seoDescription: fieldError(error, 'seoDescription'),
              ogTitle: fieldError(error, 'ogTitle'),
              ogDescription: fieldError(error, 'ogDescription'),
              ogImageKey: fieldError(error, 'ogImageKey'),
              canonicalUrl: fieldError(error, 'canonicalUrl'),
            }}
          />
          {!isEdit ? (
            <p className="mt-2 text-sm text-gray-500">
              OG/canonical/noindex станут доступны после создания бренда.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать бренд'}
        </button>
        <button type="button" onClick={() => router.push('/admin/catalog/brands')}
          className="text-sm text-gray-600 hover:underline">
          Отмена
        </button>
      </div>

      {isEdit ? (
        <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h2 className="text-sm font-semibold text-gray-800">Логотип</h2>
          <div className="mt-2 flex items-center gap-4">
            {brand!.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand!.logoUrl} alt={`Логотип ${brand!.name}`} className="h-16 w-16 rounded object-contain" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded bg-gray-200 text-xs text-gray-500">
                нет лого
              </div>
            )}
            <div>
              <label htmlFor="b-logo" className="block text-xs font-medium text-gray-600">Файл</label>
              <input id="b-logo" ref={fileRef} type="file" accept="image/*" className="mt-1 text-sm" />
            </div>
            <button type="button" onClick={uploadLogo} disabled={pending}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
              Загрузить
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
