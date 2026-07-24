'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { useTranslations } from 'next-intl';

import {
  childCount,
  expandAll,
  initialExpanded,
  isNodeExpanded,
  parseExpandedState,
  pathTo,
  visibleRows,
} from '@/lib/catalog/tree';
import type { CategoryTreeNode } from '@/lib/catalog/types';

import {
  createCategoryAction,
  updateCategoryAction,
  moveCategoryAction,
  deleteCategoryAction,
} from './form-actions';
import { errorMessage } from './action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Управление деревом категорий (docs/05 §5.4). Создание/переименование/
 * перемещение (смена родителя)/удаление через Server Actions. Защита от циклов —
 * на бэке (moveCategory); удаление категории с детьми — понятная ошибка RESTRICT.
 *
 * UX: переименование и перемещение делаются ПРЯМО в строке (inline-поле и
 * выпадающий список родителя), БЕЗ window.prompt и ручного ввода UUID — раньше
 * владелец-неспециалист не мог переместить категорию (требовался машинный ID).
 *
 * ТЗ владельца п.1: дерево раскрывается по «+» — раньше оно рендерилось целиком
 * развёрнутым, и на реальном каталоге список был нечитаемо длинным. Логика
 * видимости строк — чистые функции lib/catalog/tree (isNodeExpanded/visibleRows/
 * expandAll/pathTo), покрытые юнитами; здесь только состояние и вёрстка.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

interface FlatOption {
  id: string;
  label: string;
}

function flatten(nodes: CategoryTreeNode[], depth = 0): FlatOption[] {
  const out: FlatOption[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, label: `${'— '.repeat(depth)}${n.name}` });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

/** ID самого узла и всех его потомков — недопустимые родители при перемещении. */
function selfAndDescendants(node: CategoryTreeNode): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const c of node.children) {
    for (const id of selfAndDescendants(c)) ids.add(id);
  }
  return ids;
}

/** Ключ хранения раскрытых веток. Инстанс платформы = один магазин. */
const EXPANDED_STORAGE_KEY = 'admik:catalog:categories:expanded';

// localStorage — внешнее хранилище, у которого есть серверный снимок (его нет),
// поэтому читаем его через useSyncExternalStore, а не через setState в эффекте:
// так нет ни hydration mismatch, ни react-hooks/set-state-in-effect.
const expandedListeners = new Set<() => void>();

function subscribeExpanded(onStoreChange: () => void): () => void {
  expandedListeners.add(onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    expandedListeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

/** Снимок ДОЛЖЕН быть стабильным примитивом — новый Set каждый вызов зациклил бы рендер. */
function readExpandedSnapshot(): string | null {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY);
  } catch {
    return null;
  }
}

function serverExpandedSnapshot(): null {
  return null;
}

function writeExpandedSnapshot(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* приватный режим/переполнение — персист не критичен */
  }
  for (const listener of expandedListeners) listener();
}

export function CategoryManager({ tree }: { tree: CategoryTreeNode[] }) {
  const router = useRouter();
  const t = useTranslations();
  const [error, setError] = useState<Fail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newParent, setNewParent] = useState('');

  // Какой узел сейчас редактируется/перемещается/показывает меню действий (inline).
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveParent, setMoveParent] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);

  // Раскрытые ветки: сохранённый снимок (внешнее хранилище) + override текущей
  // сессии, у которого приоритет. Серверный снимок — null, поэтому SSR и первый
  // клиентский рендер совпадают, а сохранённое состояние React применяет сам.
  const storedRaw = useSyncExternalStore(
    subscribeExpanded,
    readExpandedSnapshot,
    serverExpandedSnapshot,
  );
  const [override, setOverride] = useState<Set<string> | null>(null);
  const expanded = useMemo(
    () => override ?? parseExpandedState(storedRaw) ?? initialExpanded(tree),
    [override, storedRaw, tree],
  );

  const options = flatten(tree);
  const rows = visibleRows(tree, expanded);

  /** Единственная точка изменения раскрытия: состояние + персист сразу, без эффекта. */
  function applyExpanded(next: Set<string>) {
    setOverride(next);
    writeExpandedSnapshot(next);
  }

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    applyExpanded(next);
  }

  /** Раскрыть ветку до узла — чтобы созданная/перемещённая категория была видна. */
  function reveal(id: string | null) {
    if (!id) return;
    const path = pathTo(tree, id);
    if (path.length === 0) return;
    applyExpanded(new Set([...expanded, ...path]));
  }

  async function run<T>(
    fn: () => Promise<ActionResult<T>>,
    okMsg: string,
  ): Promise<boolean> {
    setError(null);
    setNotice(null);
    const result = await fn();
    if (result.ok) {
      setNotice(okMsg);
      router.refresh();
      return true;
    }
    setError(result);
    return false;
  }

  async function create() {
    if (!newName.trim()) return;
    const parentId = newParent || null;
    const ok = await run(
      () =>
        createCategoryAction({
          name: newName.trim(),
          slug: newSlug.trim() || undefined,
          parentId,
        }),
      t('catalog.category.toast.created'),
    );
    if (ok) {
      reveal(parentId);
      setNewName('');
      setNewSlug('');
      setNewParent('');
    }
  }

  function startRename(node: CategoryTreeNode) {
    setMoveId(null);
    setMenuId(null);
    setRenameId(node.id);
    setRenameValue(node.name);
  }

  async function saveRename(node: CategoryTreeNode) {
    if (!renameValue.trim()) return;
    await run(() => updateCategoryAction({ id: node.id, name: renameValue.trim() }), t('catalog.category.toast.renamed'));
    setRenameId(null);
  }

  function startMove(node: CategoryTreeNode) {
    setRenameId(null);
    setMenuId(null);
    setMoveId(node.id);
    setMoveParent(node.parentId ?? '');
  }

  async function saveMove(node: CategoryTreeNode) {
    const parentId = moveParent || null;
    const ok = await run(
      () => moveCategoryAction({ id: node.id, parentId }),
      t('catalog.category.toast.moved'),
    );
    if (ok) {
      reveal(parentId);
    }
    setMoveId(null);
  }

  const btn = 'rounded border border-gray-300 px-2 py-1 text-xs font-medium hover:bg-gray-100';

  function renderNode(node: CategoryTreeNode, depth: number) {
    const forbidden = selfAndDescendants(node); // нельзя сделать родителем себя/потомка
    const parentOptions = options.filter((o) => !forbidden.has(o.id));
    const kids = childCount(node);
    const isExpanded = isNodeExpanded(node, expanded);
    const childrenId = `category-children-${node.id}`;
    return (
      <li key={node.id} className="py-1">
        <div className="flex flex-wrap items-center gap-2" style={{ paddingLeft: depth * 16 }}>
          {kids > 0 ? (
            <button
              type="button"
              onClick={() => toggle(node.id)}
              aria-expanded={isExpanded}
              // поддерево есть в DOM только раскрытым; ссылка на несуществующий id
              // ломает скринридер, а рендерить всё дерево скрытым дорого (дерево
              // магазина может быть большим) — по WAI-ARIA хватает aria-expanded
              aria-controls={isExpanded ? childrenId : undefined}
              aria-label={
                isExpanded
                  ? t('catalog.category.collapseAria', { name: node.name })
                  : t('catalog.category.expandAria', { name: node.name })
              }
              title={isExpanded ? t('catalog.category.collapseTitle') : t('catalog.category.expandTitle')}
              className="h-6 w-6 shrink-0 rounded border border-gray-300 text-sm font-bold leading-none text-gray-700 hover:bg-gray-100"
            >
              {isExpanded ? '−' : '+'}
            </button>
          ) : (
            // распорка вместо кнопки — иначе строки листьев уезжают влево
            <span aria-hidden="true" className="inline-block h-6 w-6 shrink-0" />
          )}

          {renameId === node.id ? (
            <>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button type="button" onClick={() => void saveRename(node)} className={`${btn} text-blue-700`}>
                {t('common.actions.save')}
              </button>
              <button type="button" onClick={() => setRenameId(null)} className={`${btn} text-gray-500`}>
                {t('common.actions.cancel')}
              </button>
            </>
          ) : moveId === node.id ? (
            <>
              <span className="text-sm text-gray-800">{node.name} →</span>
              <select
                value={moveParent}
                onChange={(e) => setMoveParent(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              >
                <option value="">{t('catalog.category.topLevel')}</option>
                {parentOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void saveMove(node)} className={`${btn} text-blue-700`}>
                {t('catalog.category.move')}
              </button>
              <button type="button" onClick={() => setMoveId(null)} className={`${btn} text-gray-500`}>
                {t('common.actions.cancel')}
              </button>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-800">{node.name}</span>
              {kids > 0 ? (
                <span className="text-xs text-gray-500" title={t('catalog.category.childCountTitle')}>
                  ({kids})
                </span>
              ) : null}
              {!node.isActive ? <span className="text-xs text-amber-700">{t('catalog.category.hiddenBadge')}</span> : null}
              {/* C13: переход к полной форме категории (описание + SEO/OG). */}
              <Link href={`/admin/catalog/categories/${node.id}`} className={`${btn} text-gray-700`}>
                {t('catalog.category.edit')}
              </Link>
              {/* Редкие действия убраны под «Ещё» — иначе строка длиннее имени категории. */}
              <button
                type="button"
                onClick={() => {
                  setRenameId(null);
                  setMoveId(null);
                  setMenuId(menuId === node.id ? null : node.id);
                }}
                aria-expanded={menuId === node.id}
                className={`${btn} text-gray-600`}
              >
                {t('catalog.category.more')} {menuId === node.id ? '▴' : '▾'}
              </button>
              {menuId === node.id ? (
                <>
                  <button type="button" onClick={() => startRename(node)} className={`${btn} text-gray-700`}>
                    {t('catalog.category.rename')}
                  </button>
                  <button type="button" onClick={() => startMove(node)} className={`${btn} text-gray-700`}>
                    {t('catalog.category.move')}
                  </button>
                  {/* C4: скрыть/показать категорию (is_active) — синхронизирует видимость
                      на витрине через updateCategory (COALESCE is_active). */}
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => updateCategoryAction({ id: node.id, isActive: !node.isActive }),
                        node.isActive ? t('catalog.category.toast.hidden') : t('catalog.category.toast.shown'),
                      )
                    }
                    className={`${btn} ${node.isActive ? 'text-amber-700' : 'text-green-700'}`}
                  >
                    {node.isActive ? t('catalog.category.hide') : t('catalog.category.show')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(t('catalog.category.confirmDelete', { name: node.name }))) {
                        void run(() => deleteCategoryAction({ id: node.id }), t('catalog.category.toast.deleted'));
                      }
                    }}
                    className={`${btn} text-red-600`}
                  >
                    {t('common.actions.delete')}
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
        {isExpanded ? (
          <ul id={childrenId}>{node.children.map((c) => renderNode(c, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="mb-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {notice}
        </div>
      ) : null}

      <div className="rounded-lg border border-gray-200 p-4">
        {tree.length === 0 ? (
          <p className="text-sm text-gray-500">
            {t('catalog.category.emptyHint')}
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-gray-100 pb-3">
              <button type="button" onClick={() => applyExpanded(expandAll(tree))} className={`${btn} text-gray-700`}>
                {t('catalog.category.expandAll')}
              </button>
              <button type="button" onClick={() => applyExpanded(new Set())} className={`${btn} text-gray-700`}>
                {t('catalog.category.collapseAll')}
              </button>
              <span className="text-xs text-gray-500">
                {t('catalog.category.shownCount', { shown: String(rows.length), total: String(options.length) })}
              </span>
            </div>
            <ul>{tree.map((n) => renderNode(n, 0))}</ul>
          </>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-semibold text-gray-800">{t('catalog.category.newHeading')}</h2>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="c-name" className="block text-xs font-medium text-gray-600">{t('fields.name')}*</label>
            <input id="c-name" value={newName} onChange={(e) => setNewName(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="c-slug" className="block text-xs font-medium text-gray-600">{t('catalog.category.slugLabel')}</label>
            <input id="c-slug" value={newSlug} onChange={(e) => setNewSlug(e.target.value)}
              placeholder={t('catalog.category.slugPlaceholder')}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="c-parent" className="block text-xs font-medium text-gray-600">{t('catalog.category.parentLabel')}</label>
            <select id="c-parent" value={newParent} onChange={(e) => setNewParent(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">{t('catalog.category.topLevel')}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          data-testid="category-add"
          onClick={create}
          disabled={!newName.trim()}
          className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {t('catalog.category.createButton')}
        </button>
      </div>
    </div>
  );
}
