'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

import type { Designer } from '@/lib/designers/types';

import {
  createDesignerAction,
  updateDesignerAction,
  uploadDesignerImageAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { DESIGNER_LIST_PATH, buildDesignerHref } from './designer-list-url';
import type { ActionResult } from '@/lib/server/action';
import { SeoFieldset, type SeoFieldsetValue } from '../../_components/SeoFieldset';
import {
  LocaleTabs,
  DESIGNER_TR_FIELD_DEFS,
  toTranslationsState,
  translationsPayload,
  type TranslationsState,
} from '../../_components/LocaleTabs';

/**
 * Форма дизайнера (§9, ADR §4.4). Создание/редактирование + загрузка аватара.
 * Мутации — createDesigner/updateDesigner/uploadDesignerImage (catalog.write).
 * Зеркало BrandForm с полями персоны (страна/видео/соцсети/счётчик работ).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Дизайнер для формы: доменный Designer + готовый imageUrl (резолвен на сервере). */
export type DesignerFormDesigner = Designer & { imageUrl?: string | null };

const SOCIAL_KEYS: Array<{ key: string; label: string }> = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'vk', label: 'VK' },
  { key: 'website', label: 'Сайт' },
];

export function DesignerForm({
  designer,
  locales,
  defaultLocale,
}: {
  designer: DesignerFormDesigner | null;
  locales: readonly string[];
  defaultLocale: string;
}) {
  const router = useRouter();
  // Поиск/порядок списка пришли сюда в query — возврат обязан их вернуть.
  const listQuery = useSearchParams().toString();
  const isEdit = designer !== null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [translations, setTranslations] = useState<TranslationsState>(
    toTranslationsState(designer?.translations),
  );

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [name, setName] = useState(designer?.name ?? '');
  const [slug, setSlug] = useState(designer?.slug ?? '');
  const [country, setCountry] = useState(designer?.country ?? '');
  const [description, setDescription] = useState(designer?.description ?? '');
  const [videoUrl, setVideoUrl] = useState(designer?.videoUrl ?? '');
  const [workCount, setWorkCount] = useState(String(designer?.workCount ?? 0));
  const [isActive, setIsActive] = useState(designer?.isActive ?? true);
  const [socials, setSocials] = useState<Record<string, string>>(designer?.socials ?? {});
  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: designer?.seoTitle ?? '',
    seoDescription: designer?.seoDescription ?? '',
    ogTitle: designer?.ogTitle ?? '',
    ogDescription: designer?.ogDescription ?? '',
    ogImageKey: designer?.ogImageKey ?? '',
    canonicalUrl: designer?.canonicalUrl ?? '',
    noindex: designer?.noindex ?? false,
  });

  function setSocial(key: string, value: string) {
    setSocials((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    // Соцсети: пустые значения не отправляем (не засоряем jsonb).
    const cleanSocials: Record<string, string> = {};
    for (const [k, v] of Object.entries(socials)) {
      if (v && v.trim()) cleanSocials[k] = v.trim();
    }
    const payload = {
      name: name.trim(),
      slug: slug.trim() || undefined,
      country: country.trim() || undefined,
      description,
      videoUrl: videoUrl.trim() || undefined,
      workCount: Number.isFinite(Number(workCount)) ? Math.max(0, Math.floor(Number(workCount))) : 0,
      socials: cleanSocials,
      isActive,
      seoTitle: seo.seoTitle.trim() || undefined,
      seoDescription: seo.seoDescription.trim() || undefined,
    };
    const seoExtra = {
      ogTitle: seo.ogTitle.trim() || undefined,
      ogDescription: seo.ogDescription.trim() || undefined,
      ogImageKey: seo.ogImageKey.trim() || undefined,
      canonicalUrl: seo.canonicalUrl.trim() || undefined,
      noindex: seo.noindex,
    };
    const result = isEdit
      ? await updateDesignerAction({
          id: designer!.id,
          ...payload,
          ...seoExtra,
          translations: translationsPayload(translations),
        })
      : await createDesignerAction(payload);
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Изменения сохранены.');
        router.refresh();
      } else {
        router.push(buildDesignerHref(`${DESIGNER_LIST_PATH}/${result.data.id}`, listQuery));
      }
    } else {
      setError(result);
    }
  }

  async function uploadImage() {
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
    const result = await uploadDesignerImageAction(designer!.id, fd);
    setPending(false);
    if (result.ok) {
      setSuccess('Аватар загружен.');
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

      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        fields={DESIGNER_TR_FIELD_DEFS}
        value={translations}
        onChange={setTranslations}
        mode={isEdit ? 'edit' : 'create'}
        pending={pending}
        onSave={save}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="d-name" className="block text-sm font-medium text-gray-700">Имя*</label>
            <input id="d-name" value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
            {fe('name') ? <p className="mt-1 text-xs text-red-600">{fe('name')}</p> : null}
          </div>
          <div>
            <label htmlFor="d-slug" className="block text-sm font-medium text-gray-700">ЧПУ (slug)</label>
            <input id="d-slug" value={slug} onChange={(e) => setSlug(e.target.value)}
              placeholder="авто из имени"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
            {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
          </div>
          <div>
            <label htmlFor="d-country" className="block text-sm font-medium text-gray-700">Страна</label>
            <input id="d-country" value={country} onChange={(e) => setCountry(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="d-work" className="block text-sm font-medium text-gray-700">Число работ</label>
            <input id="d-work" type="number" min={0} value={workCount} onChange={(e) => setWorkCount(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="d-desc" className="block text-sm font-medium text-gray-700">Описание</label>
            <textarea id="d-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="d-video" className="block text-sm font-medium text-gray-700">Видео (Vimeo/YouTube)</label>
            <input id="d-video" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <fieldset className="lg:col-span-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <legend className="text-sm font-medium text-gray-700">Соцсети</legend>
            {SOCIAL_KEYS.map((s) => (
              <div key={s.key}>
                <label htmlFor={`d-soc-${s.key}`} className="block text-xs font-medium text-gray-600">{s.label}</label>
                <input id={`d-soc-${s.key}`} value={socials[s.key] ?? ''} onChange={(e) => setSocial(s.key, e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              </div>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Активен
          </label>
          <div className="lg:col-span-2">
            <SeoFieldset
              value={seo}
              onChange={setSeo}
              idPrefix="d-seo"
              canonicalPlaceholder={`Авто: /designers/${slug || 'slug-дизайнера'}`}
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
                OG/canonical/noindex и аватар станут доступны после создания дизайнера.
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
          <button type="button" onClick={save} disabled={pending}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
            {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать дизайнера'}
          </button>
          <button type="button" onClick={() => router.push(buildDesignerHref(DESIGNER_LIST_PATH, listQuery))}
            className="text-sm text-gray-600 hover:underline">
            Отмена
          </button>
        </div>

        {isEdit ? (
          <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h2 className="text-sm font-semibold text-gray-800">Аватар</h2>
            <div className="mt-2 flex items-center gap-4">
              {designer!.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={designer!.imageUrl} alt={`Аватар ${designer!.name}`} className="h-16 w-16 rounded-full object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-200 text-xs text-gray-500">
                  нет фото
                </div>
              )}
              <div>
                <label htmlFor="d-image" className="block text-xs font-medium text-gray-600">Файл</label>
                <input id="d-image" ref={fileRef} type="file" accept="image/*" className="mt-1 text-sm" />
              </div>
              <button type="button" onClick={uploadImage} disabled={pending}
                className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                Загрузить
              </button>
            </div>
          </div>
        ) : null}
      </LocaleTabs>
    </div>
  );
}
