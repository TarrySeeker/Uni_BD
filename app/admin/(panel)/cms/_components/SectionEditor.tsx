'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { CMS_SECTION_TYPES, type CmsSection, type CmsSectionType } from '@/lib/cms/types';
import { SECTION_TYPE_LABELS } from '@/lib/cms/section-form';
import type { ActionResult } from '@/lib/server/action';

import { SectionForm } from './SectionForm';
import {
  upsertCmsSectionAction,
  reorderCmsSectionsAction,
  setCmsSectionEnabledAction,
  deleteCmsSectionAction,
} from './form-actions';
import { errorMessage } from './action-result';

/**
 * Редактор секций страницы (docs/11 §5.1.5, пакет 5.C-3, client).
 *
 * Возможности:
 *   - добавление секции по `type` (селектор) → форма по SECTION_FIELD_SPECS;
 *   - переключатель enabled (setCmsSectionEnabled);
 *   - drag-and-drop reorder (нативный HTML5 DnD, без доп. зависимостей) →
 *     reorderCmsSections (транзакционный UPDATE display_order на сервере);
 *   - редактирование/удаление секции.
 *
 * Каждая мутация уходит в Server Action (cms.write + assertCmsEnabled на сервере);
 * rich-text санитизируется сервером. После успеха — router.refresh() (свежий список).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function SectionEditor({
  pageId,
  sections,
}: {
  pageId: string;
  sections: CmsSection[];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [pending, setPending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState<CmsSectionType>('text');
  const [dragId, setDragId] = useState<string | null>(null);

  // Локальный порядок для DnD (оптимистично переставляем, затем сохраняем).
  const [ordered, setOrdered] = useState<CmsSection[]>(
    [...sections].sort((a, b) => a.displayOrder - b.displayOrder),
  );

  // Ресинхронизация с серверным состоянием — паттерн «adjusting state during
  // render» из React-доков (you-might-not-need-an-effect):
  //
  //   useState инициализируется лишь однажды (при монтировании), а router.refresh()
  //   НЕ размонтирует клиентский компонент — он перерисовывает дерево и приносит
  //   новый проп `sections`. Без ресинка добавленная секция не появлялась бы,
  //   а удалённая оставалась бы в списке до полной перезагрузки страницы
  //   (и владелец, считая «Добавить» сломанным, плодил бы реальные дубли).
  //
  // Сравниваем ссылку на проп с тем, на основе которого считали `ordered`.
  // Server Action → router.refresh() даёт НОВУЮ ссылку `sections`, поэтому при
  // изменении add/delete/toggle/reorder мы пересобираем порядок прямо в рендере
  // (без useEffect → без каскадных ре-рендеров и без запрета
  // react-hooks/set-state-in-effect; React сразу перезапускает рендер с новым
  // состоянием, до отрисовки в DOM — мерцания нет).
  //
  // Это сохраняет локальный UI-стейт (editingId, adding, newType, открытая
  // SectionForm) — в отличие от remount по key, который их бы сбросил.
  const [syncedFrom, setSyncedFrom] = useState(sections);
  if (sections !== syncedFrom) {
    setSyncedFrom(sections);
    setOrdered([...sections].sort((a, b) => a.displayOrder - b.displayOrder));
  }

  function handle(result: ActionResult<unknown>, onOk?: () => void) {
    setPending(false);
    if (result.ok) {
      setError(null);
      onOk?.();
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function addSection(content: Record<string, unknown>) {
    setPending(true);
    setError(null);
    // section_key — стабильный машинный ключ; генерим из type + времени.
    const sectionKey = `${newType}-${Date.now().toString(36)}`;
    const result = await upsertCmsSectionAction({
      pageId,
      sectionKey,
      content,
      displayOrder: ordered.length,
      enabled: true,
    });
    handle(result, () => setAdding(false));
  }

  async function editSection(section: CmsSection, content: Record<string, unknown>) {
    setPending(true);
    setError(null);
    const result = await upsertCmsSectionAction({
      pageId,
      sectionKey: section.sectionKey,
      content,
      displayOrder: section.displayOrder,
      enabled: section.enabled,
    });
    handle(result, () => setEditingId(null));
  }

  async function toggleEnabled(section: CmsSection) {
    setPending(true);
    setError(null);
    const result = await setCmsSectionEnabledAction({
      id: section.id,
      enabled: !section.enabled,
    });
    handle(result);
  }

  async function removeSection(section: CmsSection) {
    if (!confirm(`Удалить секцию «${section.sectionKey}»?`)) return;
    setPending(true);
    setError(null);
    const result = await deleteCmsSectionAction({ id: section.id });
    handle(result);
  }

  async function persistOrder(next: CmsSection[]) {
    setPending(true);
    setError(null);
    const result = await reorderCmsSectionsAction({
      pageId,
      order: next.map((s, i) => ({ id: s.id, displayOrder: i })),
    });
    handle(result);
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = ordered.findIndex((s) => s.id === dragId);
    const to = ordered.findIndex((s) => s.id === targetId);
    if (from === -1 || to === -1) {
      setDragId(null);
      return;
    }
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setOrdered(next);
    setDragId(null);
    void persistOrder(next);
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Секции страницы</h2>
        {!adding ? (
          <div className="flex items-center gap-2">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as CmsSectionType)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
              aria-label="Тип секции"
            >
              {CMS_SECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SECTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
            >
              Добавить секцию
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {errorMessage(error)}
        </div>
      ) : null}

      {adding ? (
        <div className="mt-4 rounded-lg border border-gray-300 bg-gray-50 p-4">
          <p className="mb-3 text-sm font-medium text-gray-700">
            Новая секция: {SECTION_TYPE_LABELS[newType]}
          </p>
          <SectionForm
            type={newType}
            initialContent={null}
            onSave={addSection}
            onCancel={() => setAdding(false)}
            pending={pending}
          />
        </div>
      ) : null}

      <ul className="mt-4 space-y-3">
        {ordered.length === 0 && !adding ? (
          <li className="rounded border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-400">
            Секций пока нет. Добавьте первую.
          </li>
        ) : null}

        {ordered.map((section) => (
          <li
            key={section.id}
            draggable
            onDragStart={() => setDragId(section.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(section.id)}
            className={`rounded-lg border p-4 ${
              dragId === section.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className="cursor-grab text-gray-400"
                  aria-hidden="true"
                  title="Перетащите для изменения порядка"
                >
                  ⠿
                </span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                  {SECTION_TYPE_LABELS[section.type]}
                </span>
                <code className="text-xs text-gray-500">{section.sectionKey}</code>
                {!section.enabled ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                    скрыта
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1 text-gray-700">
                  <input
                    type="checkbox"
                    checked={section.enabled}
                    onChange={() => toggleEnabled(section)}
                    disabled={pending}
                  />
                  Видима
                </label>
                <button
                  type="button"
                  onClick={() => setEditingId(editingId === section.id ? null : section.id)}
                  className="text-blue-700 hover:underline"
                >
                  {editingId === section.id ? 'Свернуть' : 'Редактировать'}
                </button>
                <button
                  type="button"
                  onClick={() => removeSection(section)}
                  disabled={pending}
                  className="text-red-600 hover:underline"
                >
                  Удалить
                </button>
              </div>
            </div>

            {editingId === section.id ? (
              <div className="mt-4 border-t border-gray-100 pt-4">
                <SectionForm
                  type={section.type}
                  initialContent={section.content}
                  onSave={(content) => editSection(section, content)}
                  onCancel={() => setEditingId(null)}
                  pending={pending}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
