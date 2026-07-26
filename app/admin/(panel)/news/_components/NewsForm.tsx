'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { NewsArticle } from '@/lib/news/types';
import { slugify } from '@/lib/news/slug';
import type { ActionResult } from '@/lib/server/action';
import { SeoFieldset, type SeoFieldsetValue } from '../../_components/SeoFieldset';
import {
  LocaleTabs,
  toTranslationsState,
  translationsPayload,
  type TranslatableFieldDef,
  type TranslationsState,
} from '../../_components/LocaleTabs';

import {
  createNewsAction,
  updateNewsAction,
  setNewsStatusAction,
  deleteNewsAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { NewsImageUploadButton } from './NewsImageUploadButton';

/**
 * Форма новости (docs/24 §3, образец cms PageForm). Создание/редактирование.
 *
 * Поля: title, slug (авто из title), groupLabel, excerpt, body, обложка (S3-ключ +
 * загрузчик), publishedAt, sortOrder, статус, SEO (<SeoFieldset>). Переводы
 * title/excerpt/body/group + SEO/OG — через <LocaleTabs> (RU правит базовые
 * колонки, EN/FR — оверлей). Публикация/снятие/архивирование — через кнопки
 * (setNewsStatus проходит машину статусов и проставляет published_at).
 *
 * Все мутации — Server Actions (news.write + assertNewsEnabled на сервере).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';

/** datetime-local строка (YYYY-MM-DDTHH:mm) из Date (локальное время). */
function toDatetimeLocal(d: Date | null): string {
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewsForm({
  article,
  canWrite = true,
  locales,
  defaultLocale,
}: {
  article: NewsArticle | null;
  canWrite?: boolean;
  locales: readonly string[];
  defaultLocale: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const isEdit = article !== null;

  /** Переводимые поля новости для LocaleTabs (совпадает с NEWS_TRANSLATABLE_FIELDS). */
  const NEWS_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
    { key: 'title', labelKey: 'news.newsForm.fields.title', kind: 'text' },
    { key: 'groupLabel', labelKey: 'news.newsForm.fields.group', kind: 'text' },
    { key: 'excerpt', labelKey: 'news.newsForm.fields.excerpt', kind: 'textarea' },
    { key: 'body', labelKey: 'news.newsForm.fields.body', kind: 'textarea' },
    { key: 'seoTitle', labelKey: 'fields.seoTitle', kind: 'text' },
    { key: 'seoDescription', labelKey: 'fields.seoDescription', kind: 'textarea' },
    { key: 'ogTitle', labelKey: 'fields.ogTitle', kind: 'text' },
    { key: 'ogDescription', labelKey: 'fields.ogDescription', kind: 'textarea' },
  ];

  const [translations, setTranslations] = useState<TranslationsState>(
    toTranslationsState(article?.translations),
  );
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [title, setTitle] = useState(article?.title ?? '');
  const [slug, setSlug] = useState(article?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [groupLabel, setGroupLabel] = useState(article?.groupLabel ?? '');
  const [excerpt, setExcerpt] = useState(article?.excerpt ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [coverImageKey, setCoverImageKey] = useState(article?.coverImageKey ?? '');
  const [publishedAt, setPublishedAt] = useState(toDatetimeLocal(article?.publishedAt ?? null));
  const [sortOrder, setSortOrder] = useState(String(article?.sortOrder ?? 0));
  const [status, setStatus] = useState(article?.status ?? 'draft');

  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: article?.seoTitle ?? '',
    seoDescription: article?.seoDescription ?? '',
    ogTitle: article?.ogTitle ?? '',
    ogDescription: article?.ogDescription ?? '',
    ogImageKey: article?.ogImageKey ?? '',
    canonicalUrl: article?.canonicalUrl ?? '',
    noindex: article?.noindex ?? false,
  });

  function onTitleChange(v: string) {
    setTitle(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  function buildBasePayload() {
    const payload: Record<string, unknown> = {
      title: title.trim(),
      slug: slug.trim() || undefined,
      groupLabel: groupLabel.trim() || undefined,
      excerpt: excerpt.trim() || undefined,
      body: body.trim() || undefined,
      coverImageKey: coverImageKey.trim() || undefined,
      sortOrder: sortOrder.trim() ? Number(sortOrder) : undefined,
      // 'published' через create/update запрещён схемой — только через кнопку.
      status: status === 'published' ? undefined : status,
      seoTitle: seo.seoTitle.trim() || undefined,
      seoDescription: seo.seoDescription.trim() || undefined,
      ogTitle: seo.ogTitle.trim() || undefined,
      ogDescription: seo.ogDescription.trim() || undefined,
      ogImageKey: seo.ogImageKey.trim() || undefined,
      canonicalUrl: seo.canonicalUrl.trim() || undefined,
      noindex: seo.noindex,
    };
    // publishedAt: непустое поле → ISO; пустое — не трогаем (undefined).
    if (publishedAt.trim()) {
      const d = new Date(publishedAt);
      if (!Number.isNaN(d.getTime())) payload.publishedAt = d.toISOString();
    }
    return payload;
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const base = buildBasePayload();
    const result = isEdit
      ? await updateNewsAction({
          id: article!.id,
          ...base,
          translations: translationsPayload(translations),
        })
      : await createNewsAction(base);
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess(t('news.newsForm.toast.saved'));
        router.refresh();
      } else {
        router.push(`/admin/news/${(result.data as { id: string }).id}`);
      }
    } else {
      setError(result as Fail);
    }
  }

  async function changeStatus(next: 'published' | 'draft' | 'archived', okMsg: string) {
    if (!isEdit) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    // Сначала сохраняем текущие правки, затем меняем статус (не терять несохранённое).
    const saved = await updateNewsAction({
      id: article!.id,
      ...buildBasePayload(),
      translations: translationsPayload(translations),
    });
    if (!saved.ok) {
      setPending(false);
      setError(saved as Fail);
      return;
    }
    const res = await setNewsStatusAction({ id: article!.id, status: next });
    setPending(false);
    if (res.ok) {
      setStatus(next);
      setSuccess(okMsg);
      router.refresh();
    } else {
      setError(res as Fail);
    }
  }

  async function remove() {
    if (!isEdit) return;
    if (!confirm(t('news.newsForm.confirmDelete'))) return;
    setPending(true);
    setError(null);
    const result = await deleteNewsAction({ id: article!.id });
    setPending(false);
    if (result.ok) {
      router.push('/admin/news');
    } else {
      setError(result as Fail);
    }
  }

  const fe = (f: string) => fieldError(error, f);

  return (
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

      {!canWrite ? (
        <div role="status" className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t('news.newsForm.noWriteWarning')}
        </div>
      ) : null}

      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        fields={NEWS_TR_FIELD_DEFS}
        value={translations}
        onChange={setTranslations}
        mode={isEdit ? 'edit' : 'create'}
        disabled={!canWrite}
        pending={pending}
        onSave={save}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="n-title" className={labelCls}>{t('news.newsForm.fields.titleRequired')}</label>
            <input id="n-title" value={title} onChange={(e) => onTitleChange(e.target.value)}
              className={inputCls} required disabled={!canWrite} />
            {fe('title') ? <p className="mt-1 text-xs text-red-600">{fe('title')}</p> : null}
          </div>
          <div>
            <label htmlFor="n-slug" className={labelCls}>{t('news.newsForm.fields.slug')}</label>
            <input id="n-slug" value={slug} placeholder={t('news.newsForm.slugPlaceholder')}
              onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
              className={inputCls} disabled={!canWrite} />
            {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
          </div>

          <div>
            <label htmlFor="n-group" className={labelCls}>{t('news.newsForm.fields.group')}</label>
            <input id="n-group" value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)}
              className={inputCls} disabled={!canWrite} />
          </div>
          <div>
            <label htmlFor="n-status" className={labelCls}>{t('news.newsForm.fields.status')}</label>
            <select id="n-status" value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className={inputCls} disabled={!canWrite}>
              <option value="draft">{t('news.newsForm.status.draft')}</option>
              {status === 'published' ? <option value="published" disabled>{t('news.newsForm.status.published')}</option> : null}
              <option value="archived">{t('news.newsForm.status.archived')}</option>
            </select>
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="n-excerpt" className={labelCls}>{t('news.newsForm.fields.excerpt')}</label>
            <textarea id="n-excerpt" value={excerpt} rows={2}
              onChange={(e) => setExcerpt(e.target.value)} className={inputCls} disabled={!canWrite} />
            {fe('excerpt') ? <p className="mt-1 text-xs text-red-600">{fe('excerpt')}</p> : null}
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="n-body" className={labelCls}>{t('news.newsForm.fields.bodyHtml')}</label>
            <textarea id="n-body" value={body} rows={10}
              onChange={(e) => setBody(e.target.value)} className={`${inputCls} font-mono`} disabled={!canWrite} />
            <p className="mt-1 text-xs text-gray-400">
              {t('news.newsForm.bodyHelp')}
            </p>
          </div>

          <div>
            <label htmlFor="n-cover" className={labelCls}>{t('news.newsForm.fields.cover')}</label>
            <input id="n-cover" value={coverImageKey} onChange={(e) => setCoverImageKey(e.target.value)}
              placeholder="news/<id>.webp" className={inputCls} disabled={!canWrite} />
            {canWrite ? (
              <NewsImageUploadButton label={t('news.newsForm.uploadCover')} onUploaded={setCoverImageKey} />
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="n-pub" className={labelCls}>{t('news.newsForm.fields.publishedAt')}</label>
              <input id="n-pub" type="datetime-local" value={publishedAt}
                onChange={(e) => setPublishedAt(e.target.value)} className={inputCls} disabled={!canWrite} />
            </div>
            <div>
              <label htmlFor="n-sort" className={labelCls}>{t('news.newsForm.fields.sortOrder')}</label>
              <input id="n-sort" type="number" min="0" value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)} className={inputCls} disabled={!canWrite} />
            </div>
          </div>

          <div className="lg:col-span-2">
            <SeoFieldset value={seo} onChange={setSeo} idPrefix="n-seo"
              canonicalPlaceholder={t('news.newsForm.seo.canonicalPlaceholder', { slug: slug || t('news.newsForm.seo.slugFallback') })}
              disabled={!canWrite}
              fieldErrors={{
                seoTitle: fe('seoTitle'),
                seoDescription: fe('seoDescription'),
                ogTitle: fe('ogTitle'),
                ogDescription: fe('ogDescription'),
                ogImageKey: fe('ogImageKey'),
                canonicalUrl: fe('canonicalUrl'),
              }}
              ogImageSlot={
                <NewsImageUploadButton label={t('news.newsForm.uploadImage')}
                  onUploaded={(key) => setSeo((prev) => ({ ...prev, ogImageKey: key }))} />
              }
            />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
          {canWrite ? (
            <>
              <button type="button" onClick={save} disabled={pending}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                {pending ? t('common.form.saving') : isEdit ? t('common.actions.save') : t('news.newsForm.createButton')}
              </button>

              {isEdit && status !== 'published' ? (
                <button type="button" onClick={() => changeStatus('published', t('news.newsForm.toast.published'))}
                  disabled={pending}
                  className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50">
                  {t('news.newsForm.saveAndPublish')}
                </button>
              ) : null}
              {isEdit && status === 'published' ? (
                <button type="button" onClick={() => changeStatus('draft', t('news.newsForm.toast.unpublished'))}
                  disabled={pending}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">
                  {t('news.newsForm.unpublish')}
                </button>
              ) : null}
              {isEdit && status !== 'archived' ? (
                <button type="button" onClick={() => changeStatus('archived', t('news.newsForm.toast.archived'))}
                  disabled={pending}
                  className="rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50">
                  {t('news.newsForm.archive')}
                </button>
              ) : null}
            </>
          ) : null}

          <button type="button" onClick={() => router.push('/admin/news')}
            className="text-sm text-gray-600 hover:underline">
            {canWrite ? t('common.actions.cancel') : t('news.newsForm.backToList')}
          </button>

          {isEdit && canWrite ? (
            <button type="button" onClick={remove} disabled={pending}
              className="ml-auto text-sm text-red-600 hover:underline disabled:opacity-50">
              {t('news.newsForm.deleteButton')}
            </button>
          ) : null}
        </div>
      </LocaleTabs>
    </div>
  );
}
