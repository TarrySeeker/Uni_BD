'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

export function CategoryManager({ tree }: { tree: CategoryTreeNode[] }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newParent, setNewParent] = useState('');

  // Какой узел сейчас редактируется/перемещается (inline).
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveParent, setMoveParent] = useState('');

  const options = flatten(tree);

  async function run<T>(
    fn: () => Promise<ActionResult<T>>,
    okMsg: string,
  ): Promise<void> {
    setError(null);
    setNotice(null);
    const result = await fn();
    if (result.ok) {
      setNotice(okMsg);
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function create() {
    if (!newName.trim()) return;
    await run(
      () =>
        createCategoryAction({
          name: newName.trim(),
          slug: newSlug.trim() || undefined,
          parentId: newParent || null,
        }),
      'Категория создана.',
    );
    setNewName('');
    setNewSlug('');
    setNewParent('');
  }

  function startRename(node: CategoryTreeNode) {
    setMoveId(null);
    setRenameId(node.id);
    setRenameValue(node.name);
  }

  async function saveRename(node: CategoryTreeNode) {
    if (!renameValue.trim()) return;
    await run(() => updateCategoryAction({ id: node.id, name: renameValue.trim() }), 'Переименовано.');
    setRenameId(null);
  }

  function startMove(node: CategoryTreeNode) {
    setRenameId(null);
    setMoveId(node.id);
    setMoveParent(node.parentId ?? '');
  }

  async function saveMove(node: CategoryTreeNode) {
    await run(
      () => moveCategoryAction({ id: node.id, parentId: moveParent || null }),
      'Категория перемещена.',
    );
    setMoveId(null);
  }

  const btn = 'rounded border border-gray-300 px-2 py-1 text-xs font-medium hover:bg-gray-100';

  function renderNode(node: CategoryTreeNode, depth: number) {
    const forbidden = selfAndDescendants(node); // нельзя сделать родителем себя/потомка
    const parentOptions = options.filter((o) => !forbidden.has(o.id));
    return (
      <li key={node.id} className="py-1">
        <div className="flex flex-wrap items-center gap-2" style={{ paddingLeft: depth * 16 }}>
          {renameId === node.id ? (
            <>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button type="button" onClick={() => void saveRename(node)} className={`${btn} text-blue-700`}>
                Сохранить
              </button>
              <button type="button" onClick={() => setRenameId(null)} className={`${btn} text-gray-500`}>
                Отмена
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
                <option value="">— верхний уровень —</option>
                {parentOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void saveMove(node)} className={`${btn} text-blue-700`}>
                Переместить
              </button>
              <button type="button" onClick={() => setMoveId(null)} className={`${btn} text-gray-500`}>
                Отмена
              </button>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-800">{node.name}</span>
              {!node.isActive ? <span className="text-xs text-amber-700">(скрыта)</span> : null}
              <button type="button" onClick={() => startRename(node)} className={`${btn} text-gray-700`}>
                Переименовать
              </button>
              <button type="button" onClick={() => startMove(node)} className={`${btn} text-gray-700`}>
                Переместить
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Удалить категорию «${node.name}»?`)) {
                    void run(() => deleteCategoryAction({ id: node.id }), 'Категория удалена.');
                  }
                }}
                className={`${btn} text-red-600`}
              >
                Удалить
              </button>
            </>
          )}
        </div>
        {node.children.length > 0 ? (
          <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
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
            Категорий пока нет. Создайте первую в форме ниже — по категориям товары
            раскладываются в каталоге на сайте.
          </p>
        ) : (
          <ul>{tree.map((n) => renderNode(n, 0))}</ul>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-semibold text-gray-800">Новая категория</h2>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="c-name" className="block text-xs font-medium text-gray-600">Название*</label>
            <input id="c-name" value={newName} onChange={(e) => setNewName(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="c-slug" className="block text-xs font-medium text-gray-600">Адрес на сайте</label>
            <input id="c-slug" value={newSlug} onChange={(e) => setNewSlug(e.target.value)}
              placeholder="можно не заполнять — создастся автоматически"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="c-parent" className="block text-xs font-medium text-gray-600">Внутри категории</label>
            <select id="c-parent" value={newParent} onChange={(e) => setNewParent(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">— верхний уровень —</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={!newName.trim()}
          className="mt-3 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Создать категорию
        </button>
      </div>
    </div>
  );
}
