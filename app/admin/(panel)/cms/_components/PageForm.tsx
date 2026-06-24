'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { CmsPageWithSections } from '@/lib/cms/types';
import { SITEMAP_CHANGEFREQS } from '@/lib/cms/types';
import type { ActionResult } from '@/lib/server/action';
import { SeoFieldset, type SeoFieldsetValue } from '../../_components/SeoFieldset';

import {
  createCmsPageAction,
  updateCmsPageAction,
  publishCmsPageAction,
  unpublishCmsPageAction,
  deleteCmsPageAction,
} from './form-actions';
import { errorMessage, fieldError } from './action-result';
import { SectionEditor } from './SectionEditor';

/**
 * Форма CMS-страницы (docs/11 §5.1.5, пакет 5.C-3). Создание/редактирование.
 *
 * Поля: title, slug (авто из title, редактируемо), статус, SEO через
 * <SeoFieldset> (из W2) + sitemap_priority/changefreq, кнопки Publish/Unpublish.
 * В режиме редактирования снизу — SectionEditor (drag-and-drop секции).
 *
 * Все мутации — Server Actions CMS (cms.write + assertCmsEnabled на сервере).
 * SeoFieldset универсален; для CMS-страницы используем подмножество его полей:
 * seoTitle/seoDescription/canonicalUrl/noindex и поле «ключ OG» как ogImageUrl
 * (схема страницы хранит ogImageUrl text; ogTitle/ogDescription у страницы нет).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';

/** slugify-превью на клиенте (UX-подсказка; источник правды — сервер). */
function previewSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё\s-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function PageForm({ page }: { page: CmsPageWithSections | null }) {
  const router = useRouter();
  const isEdit = page !== null;

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [title, setTitle] = useState(page?.title ?? '');
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [status, setStatus] = useState(page?.status ?? 'draft');
  const [sitemapPriority, setSitemapPriority] = useState(
    page?.sitemapPriority != null ? String(page.sitemapPriority) : '',
  );
  const [sitemapChangefreq, setSitemapChangefreq] = useState(
    page?.sitemapChangefreq ?? '',
  );

  // SeoFieldset: для страницы маппим ogImageKey ↔ ogImageUrl; ogTitle/ogDescription
  // у страницы нет (не входят в схему) — поля скрыты ниже не будут, но не отправляются.
  const [seo, setSeo] = useState<SeoFieldsetValue>({
    seoTitle: page?.seoTitle ?? '',
    seoDescription: page?.seoDescription ?? '',
    ogTitle: '',
    ogDescription: '',
    ogImageKey: page?.ogImageUrl ?? '',
    canonicalUrl: page?.canonicalUrl ?? '',
    noindex: page?.noindex ?? false,
  });

  function onTitleChange(v: string) {
    setTitle(v);
    if (!slugTouched) setSlug(previewSlug(v));
  }

  function pageSeoPayload() {
    return {
      seoTitle: seo.seoTitle.trim() || undefined,
      seoDescription: seo.seoDescription.trim() || undefined,
      ogImageUrl: seo.ogImageKey.trim() || undefined,
      canonicalUrl: seo.canonicalUrl.trim() || undefined,
      noindex: seo.noindex,
      sitemapPriority: sitemapPriority.trim() ? Number(sitemapPriority) : undefined,
      sitemapChangefreq: sitemapChangefreq.trim() || undefined,
    };
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    // 'published' через create/update запрещён схемой (баг B волны 5): публикация
    // идёт только через кнопку «Опубликовать» (publishCmsPage). При сохранении уже
    // опубликованной страницы статус не трогаем (undefined → COALESCE сохраняет
    // 'published' и published_at в БД); отправляем лишь редактируемый 'draft'/'archived'.
    const base = {
      title: title.trim(),
      slug: slug.trim() || undefined,
      status: status === 'published' ? undefined : status,
      ...pageSeoPayload(),
    };
    const result = isEdit
      ? await updateCmsPageAction({ id: page!.id, ...base })
      : await createCmsPageAction(base);
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Изменения сохранены.');
        router.refresh();
      } else {
        router.push(`/admin/cms/${result.data.id}`);
      }
    } else {
      setError(result);
    }
  }

  async function runPageAction(
    fn: (input: unknown) => Promise<ActionResult<unknown>>,
    okMsg: string,
  ) {
    if (!isEdit) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await fn({ id: page!.id });
    setPending(false);
    if (result.ok) {
      setSuccess(okMsg);
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function remove() {
    if (!isEdit) return;
    if (!confirm('Удалить страницу со всеми секциями? Действие необратимо.')) return;
    setPending(true);
    setError(null);
    const result = await deleteCmsPageAction({ id: page!.id });
    setPending(false);
    if (result.ok) {
      router.push('/admin/cms');
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
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700"
        >
          {success}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="p-title" className={labelCls}>
            Заголовок*
          </label>
          <input
            id="p-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className={inputCls}
            required
          />
          {fe('title') ? <p className="mt-1 text-xs text-red-600">{fe('title')}</p> : null}
        </div>
        <div>
          <label htmlFor="p-slug" className={labelCls}>
            ЧПУ (slug)
          </label>
          <input
            id="p-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="авто из заголовка"
            className={inputCls}
          />
          {fe('slug') ? <p className="mt-1 text-xs text-red-600">{fe('slug')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-status" className={labelCls}>
            Статус
          </label>
          <select
            id="p-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className={inputCls}
          >
            <option value="draft">Черновик</option>
            {/* «Опубликована» НЕ выбирается вручную (баг B волны 5): публикация —
                только через кнопку «Опубликовать» (publishCmsPage: published_at +
                ревизия). Если страница уже опубликована — показываем статус как
                disabled-вариант, чтобы select не сбрасывался на «Черновик». */}
            {status === 'published' ? (
              <option value="published" disabled>
                Опубликована
              </option>
            ) : null}
            <option value="archived">В архиве</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="p-prio" className={labelCls}>
              Sitemap priority (0–1)
            </label>
            <input
              id="p-prio"
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={sitemapPriority}
              onChange={(e) => setSitemapPriority(e.target.value)}
              className={inputCls}
            />
            {fe('sitemapPriority') ? (
              <p className="mt-1 text-xs text-red-600">{fe('sitemapPriority')}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor="p-cf" className={labelCls}>
              Sitemap changefreq
            </label>
            <select
              id="p-cf"
              value={sitemapChangefreq}
              onChange={(e) => setSitemapChangefreq(e.target.value)}
              className={inputCls}
            >
              <option value="">—</option>
              {SITEMAP_CHANGEFREQS.map((cf) => (
                <option key={cf} value={cf}>
                  {cf}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="lg:col-span-2">
          <SeoFieldset
            value={seo}
            onChange={setSeo}
            idPrefix="p-seo"
            canonicalPlaceholder={`Авто: /pages/${slug || 'slug-страницы'}`}
            fieldErrors={{
              seoTitle: fe('seoTitle'),
              seoDescription: fe('seoDescription'),
              ogImageKey: fe('ogImageUrl'),
              canonicalUrl: fe('canonicalUrl'),
            }}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать страницу'}
        </button>

        {isEdit && page!.status !== 'published' ? (
          <button
            type="button"
            onClick={() => runPageAction(publishCmsPageAction, 'Страница опубликована.')}
            disabled={pending}
            className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
          >
            Опубликовать
          </button>
        ) : null}
        {isEdit && page!.status === 'published' ? (
          <button
            type="button"
            onClick={() => runPageAction(unpublishCmsPageAction, 'Снято с публикации.')}
            disabled={pending}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Снять с публикации
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => router.push('/admin/cms')}
          className="text-sm text-gray-600 hover:underline"
        >
          Отмена
        </button>

        {isEdit ? (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="ml-auto text-sm text-red-600 hover:underline disabled:opacity-50"
          >
            Удалить страницу
          </button>
        ) : null}
      </div>

      {!isEdit ? (
        <p className="mt-4 text-sm text-gray-500">
          Секции страницы станут доступны после её создания.
        </p>
      ) : (
        <SectionEditor pageId={page!.id} sections={page!.sections} />
      )}
    </div>
  );
}
