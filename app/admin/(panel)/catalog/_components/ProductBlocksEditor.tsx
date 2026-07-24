'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ProductBlock, ProductBlockType, ProductBlockTab } from '@/lib/product-blocks/types';
import { PRODUCT_BLOCK_TYPES } from '@/lib/product-blocks/types';
import type { ActionResult } from '@/lib/server/action';

import {
  upsertProductBlockAction,
  reorderProductBlocksAction,
  deleteProductBlockAction,
  uploadProductBlockImageAction,
} from './form-actions';
import { errorMessage } from './action-result';

/**
 * Редактор структурных секций карточки товара (§9, product_blocks). Порт eAdmin
 * b_work_block: типы «текст», «цитата+автор», «табы», «картинка». Add/edit/reorder/
 * delete; LocaleTabs-подобный переключатель языков для переводимых полей
 * (title/blockquot/body + tab name/text). RBAC — catalog.write (сервер отклонит без права).
 */

/** Дизайнер для селекта автора цитаты. */
export interface AuthorOption {
  id: string;
  name: string;
}

/** Секция + резолвенный на сервере URL картинки (для превью). */
export type EditorBlock = ProductBlock & { imageUrl?: string | null };

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Локальное состояние переводов секции: locale → поля. */
interface LocaleOverlay {
  title?: string;
  blockquot?: string;
  body?: string;
  tabs?: ProductBlockTab[];
}

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';

function coerceTabs(v: unknown): ProductBlockTab[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => {
    const o = (t ?? {}) as { name?: unknown; text?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : '',
      text: typeof o.text === 'string' ? o.text : '',
    };
  });
}

/** Один редактор секции (изолированное состояние). */
function BlockCard({
  block,
  productId,
  authors,
  locales,
  defaultLocale,
  onChanged,
  onReorder,
  index,
  total,
}: {
  block: EditorBlock;
  productId: string;
  authors: AuthorOption[];
  locales: readonly string[];
  defaultLocale: string;
  onChanged: () => void;
  onReorder: (dir: -1 | 1) => void;
  index: number;
  total: number;
}) {
  const router = useRouter();
  const t = useTranslations();
  const fileRef = useRef<HTMLInputElement>(null);
  const isNew = !block.id;

  const typeLabels: Record<ProductBlockType, string> = {
    text: t('catalog.blocks.types.text'),
    quote: t('catalog.blocks.types.quote'),
    tabs: t('catalog.blocks.types.tabs'),
    image: t('catalog.blocks.types.image'),
  };

  const [type, setType] = useState<ProductBlockType>(block.type);
  const [title, setTitle] = useState(block.title ?? '');
  const [blockquot, setBlockquot] = useState(block.blockquot ?? '');
  const [body, setBody] = useState(block.body ?? '');
  const [authorId, setAuthorId] = useState(block.authorDesignerId ?? '');
  const [tabs, setTabs] = useState<ProductBlockTab[]>(block.tabs.length ? block.tabs : []);

  const overlayLocales = locales.filter((l) => l !== defaultLocale);
  const [tr, setTr] = useState<Record<string, LocaleOverlay>>(() => {
    const out: Record<string, LocaleOverlay> = {};
    const raw = (block.translations ?? {}) as Record<string, Record<string, unknown>>;
    for (const loc of overlayLocales) {
      const o = raw[loc] ?? {};
      out[loc] = {
        title: typeof o.title === 'string' ? o.title : '',
        blockquot: typeof o.blockquot === 'string' ? o.blockquot : '',
        body: typeof o.body === 'string' ? o.body : '',
        tabs: coerceTabs(o.tabs),
      };
    }
    return out;
  });

  const [active, setActive] = useState<string>(defaultLocale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Fail | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const isBase = active === defaultLocale;

  function setOverlay(loc: string, patch: Partial<LocaleOverlay>) {
    setTr((prev) => ({ ...prev, [loc]: { ...(prev[loc] ?? {}), ...patch } }));
  }
  function overlayTab(loc: string, i: number, patch: Partial<ProductBlockTab>) {
    setTr((prev) => {
      const cur = prev[loc] ?? {};
      const arr = coerceTabs(cur.tabs);
      while (arr.length <= i) arr.push({ name: '', text: '' });
      arr[i] = { ...arr[i]!, ...patch };
      return { ...prev, [loc]: { ...cur, tabs: arr } };
    });
  }

  function setTab(i: number, patch: Partial<ProductBlockTab>) {
    setTabs((prev) => {
      const arr = [...prev];
      arr[i] = { ...arr[i]!, ...patch };
      return arr;
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    setOk(null);
    const translations: Record<string, LocaleOverlay> = {};
    for (const loc of overlayLocales) {
      const o = tr[loc] ?? {};
      translations[loc] = {
        title: o.title?.trim() || undefined,
        blockquot: o.blockquot?.trim() || undefined,
        body: o.body || undefined,
        tabs: type === 'tabs' ? coerceTabs(o.tabs) : undefined,
      };
    }
    const res = await upsertProductBlockAction({
      id: block.id || undefined,
      productId,
      type,
      title: title.trim() || null,
      blockquot: type === 'quote' ? blockquot : null,
      authorDesignerId: type === 'quote' ? authorId || null : null,
      body: type === 'text' ? body : null,
      tabs: type === 'tabs' ? tabs : [],
      translations,
    });
    setPending(false);
    if (res.ok) {
      setOk(t('catalog.blocks.toast.saved'));
      onChanged();
      router.refresh();
    } else {
      setError(res);
    }
  }

  async function remove() {
    if (!block.id) {
      onChanged();
      return;
    }
    if (!confirm(t('catalog.blocks.confirms.delete'))) return;
    setPending(true);
    const res = await deleteProductBlockAction({ id: block.id });
    setPending(false);
    if (res.ok) {
      onChanged();
      router.refresh();
    } else {
      setError(res);
    }
  }

  async function uploadImage() {
    if (!block.id) {
      setError({ ok: false, error: 'validation', fieldErrors: { file: [t('catalog.blocks.errors.saveFirst')] } });
      return;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setPending(true);
    const fd = new FormData();
    fd.set('file', file);
    const res = await uploadProductBlockImageAction(block.id, fd);
    setPending(false);
    if (res.ok) {
      setOk(t('catalog.blocks.toast.imageUploaded'));
      if (fileRef.current) fileRef.current.value = '';
      router.refresh();
    } else {
      setError(res);
    }
  }

  const showTabs = type === 'tabs';
  const showQuote = type === 'quote';
  const showText = type === 'text';
  const showImage = type === 'image' || type === 'quote';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            aria-label={t('catalog.blocks.labels.type')}
            value={type}
            onChange={(e) => setType(e.target.value as ProductBlockType)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {PRODUCT_BLOCK_TYPES.map((bt) => (
              <option key={bt} value={bt}>
                {typeLabels[bt]}
              </option>
            ))}
          </select>
          {isNew ? <span className="text-xs text-amber-600">{t('catalog.blocks.unsaved')}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onReorder(-1)} disabled={index === 0 || pending}
            className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40" aria-label={t('catalog.blocks.aria.up')}>↑</button>
          <button type="button" onClick={() => onReorder(1)} disabled={index === total - 1 || pending}
            className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40" aria-label={t('catalog.blocks.aria.down')}>↓</button>
          <button type="button" onClick={remove} disabled={pending}
            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-40">{t('common.actions.delete')}</button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {ok ? (
        <div role="status" className="mt-3 rounded border border-green-200 bg-green-50 p-2 text-xs text-green-700">{ok}</div>
      ) : null}

      {overlayLocales.length > 0 ? (
        <div role="tablist" aria-label={t('catalog.blocks.aria.localeTabs')} className="mt-3 flex flex-wrap gap-1 border-b border-gray-200">
          {[defaultLocale, ...overlayLocales].map((loc) => (
            <button key={loc} role="tab" type="button" aria-selected={active === loc}
              onClick={() => setActive(loc)}
              className={`px-3 py-1.5 text-xs font-medium ${active === loc ? 'border-b-2 border-gray-900 text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
              {loc === defaultLocale ? t('localeTabs.baseTab', { locale: loc.toUpperCase() }) : loc.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4">
        {/* Заголовок — переводимое поле, всегда доступно. */}
        <div>
          <label className={labelCls}>{t('fields.title')}</label>
          {isBase ? (
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          ) : (
            <input value={tr[active]?.title ?? ''} placeholder={t('catalog.blocks.placeholders.fallbackToBase')}
              onChange={(e) => setOverlay(active, { title: e.target.value })} className={inputCls} />
          )}
        </div>

        {showText ? (
          <div>
            <label className={labelCls}>{t('catalog.blocks.labels.bodyHtml')}</label>
            {isBase ? (
              <textarea value={body} rows={5} onChange={(e) => setBody(e.target.value)} className={inputCls} />
            ) : (
              <textarea value={tr[active]?.body ?? ''} rows={5} placeholder={t('catalog.blocks.placeholders.fallbackToBase')}
                onChange={(e) => setOverlay(active, { body: e.target.value })} className={inputCls} />
            )}
          </div>
        ) : null}

        {showQuote ? (
          <>
            <div>
              <label className={labelCls}>{t('catalog.blocks.types.quote')}</label>
              {isBase ? (
                <textarea value={blockquot} rows={3} onChange={(e) => setBlockquot(e.target.value)} className={inputCls} />
              ) : (
                <textarea value={tr[active]?.blockquot ?? ''} rows={3} placeholder={t('catalog.blocks.placeholders.fallbackToBase')}
                  onChange={(e) => setOverlay(active, { blockquot: e.target.value })} className={inputCls} />
              )}
            </div>
            {isBase ? (
              <div>
                <label className={labelCls}>{t('catalog.blocks.labels.author')}</label>
                <select value={authorId} onChange={(e) => setAuthorId(e.target.value)} className={inputCls}>
                  <option value="">{t('catalog.blocks.authorNone')}</option>
                  {authors.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        ) : null}

        {showTabs ? (
          <fieldset className="rounded border border-gray-200 p-3">
            <legend className="text-sm font-medium text-gray-700">{t('catalog.blocks.types.tabs')}</legend>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mt-2 grid grid-cols-1 gap-2 border-t border-gray-100 pt-2 first:border-0">
                <input placeholder={t('catalog.blocks.placeholders.tabName', { n: i + 1 })}
                  value={isBase ? (tabs[i]?.name ?? '') : (coerceTabs(tr[active]?.tabs)[i]?.name ?? '')}
                  onChange={(e) => (isBase ? setTab(i, { name: e.target.value }) : overlayTab(active, i, { name: e.target.value }))}
                  className={inputCls} />
                <textarea placeholder={t('catalog.blocks.placeholders.tabText', { n: i + 1 })} rows={2}
                  value={isBase ? (tabs[i]?.text ?? '') : (coerceTabs(tr[active]?.tabs)[i]?.text ?? '')}
                  onChange={(e) => (isBase ? setTab(i, { text: e.target.value }) : overlayTab(active, i, { text: e.target.value }))}
                  className={inputCls} />
              </div>
            ))}
          </fieldset>
        ) : null}

        {showImage && isBase ? (
          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <label className={labelCls}>{t('catalog.blocks.labels.image')}</label>
            {block.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={block.imageUrl} alt="" className="mt-2 h-24 w-auto rounded object-cover" />
            ) : (
              <p className="mt-1 text-xs text-gray-500">{t('catalog.blocks.noImage')}</p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <input ref={fileRef} type="file" accept="image/*" className="text-sm" />
              <button type="button" onClick={uploadImage} disabled={pending || isNew}
                className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                {t('catalog.blocks.buttons.upload')}
              </button>
            </div>
            {isNew ? <p className="mt-1 text-xs text-gray-500">{t('catalog.blocks.saveToUpload')}</p> : null}
          </div>
        ) : null}

        <input aria-hidden type="hidden" />
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-gray-200 pt-3">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('catalog.blocks.buttons.save')}
        </button>
      </div>
    </div>
  );
}

export function ProductBlocksEditor({
  productId,
  blocks,
  authors,
  locales = ['ru'],
  defaultLocale = 'ru',
}: {
  productId: string;
  blocks: EditorBlock[];
  authors: AuthorOption[];
  locales?: readonly string[];
  defaultLocale?: string;
}) {
  const router = useRouter();
  const t = useTranslations();
  // Локальный список: серверные секции + черновики (без id) до первого сохранения.
  const [drafts, setDrafts] = useState<EditorBlock[]>([]);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const all: EditorBlock[] = [...blocks, ...drafts];

  function emptyBlock(): EditorBlock {
    return {
      id: '',
      productId,
      type: 'text',
      title: null,
      blockquot: null,
      authorDesignerId: null,
      author: null,
      body: null,
      imageKey: null,
      imageUrl: null,
      tabs: [],
      sort: all.length,
      translations: {},
      createdAt: new Date(),
    };
  }

  function addBlock() {
    setDrafts((d) => [...d, emptyBlock()]);
  }

  async function reorder(fromIdx: number, dir: -1 | 1) {
    const persisted = blocks.slice();
    const toIdx = fromIdx + dir;
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= persisted.length || toIdx >= persisted.length) {
      return;
    }
    const moved = persisted.splice(fromIdx, 1)[0]!;
    persisted.splice(toIdx, 0, moved);
    const order = persisted.map((b) => b.id).filter(Boolean);
    setReorderError(null);
    const res = await reorderProductBlocksAction({ productId, order });
    if (res.ok) {
      router.refresh();
    } else {
      setReorderError(t('catalog.blocks.errors.reorderFailed'));
    }
  }

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">{t('catalog.blocks.title')}</h2>
        <button type="button" onClick={addBlock}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
          {t('catalog.blocks.addButton')}
        </button>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        {t('catalog.blocks.intro')}
      </p>
      {reorderError ? (
        <div role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{reorderError}</div>
      ) : null}

      {all.length === 0 ? (
        <p className="mt-4 rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
          {t('catalog.blocks.empty')}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {all.map((b, i) => (
            <BlockCard
              key={b.id || `draft-${i}`}
              block={b}
              productId={productId}
              authors={authors}
              locales={locales}
              defaultLocale={defaultLocale}
              index={i}
              total={all.length}
              onReorder={(dir) => (b.id ? reorder(i, dir) : undefined)}
              onChanged={() => {
                // Убираем черновики из локального списка (сервер вернёт свежие через refresh).
                setDrafts([]);
                router.refresh();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
