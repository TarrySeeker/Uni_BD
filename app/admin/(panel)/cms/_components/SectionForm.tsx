'use client';

import { useState } from 'react';

import {
  SECTION_FIELD_SPECS,
  buildSectionContent,
  formStateFromContent,
  emptyFormStateFor,
  type SectionFormState,
  type SectionFieldSpec,
} from '@/lib/cms/section-form';
import type { CmsSectionType } from '@/lib/cms/types';

import { RichTextEditor } from './RichTextEditor';

/**
 * Форма содержимого одной секции (docs/11 §5.1.5). Единый редактор: набор полей
 * выбирается по `type` через SECTION_FIELD_SPECS (чистый маппинг, протестирован в
 * tests/cms/section-form.test.ts). Сборка `content` — buildSectionContent
 * (валидируется тем же CmsSectionContentSchema, что и сервер). rich-text-поля —
 * Tiptap; их HTML санитизирует сервер при upsertCmsSection (анти-XSS, инвариант 5.1).
 *
 * Вызывает onSave(content) с уже собранным/провалидированным на клиенте content;
 * сервер всё равно перевалидирует и санитизирует (доверие клиенту запрещено).
 */
export interface SectionFormProps {
  type: CmsSectionType;
  /** Сохранённый content (режим редактирования) или null (новая секция). */
  initialContent: Record<string, unknown> | null;
  onSave: (content: Record<string, unknown>) => void | Promise<void>;
  onCancel?: () => void;
  pending?: boolean;
}

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
const labelCls = 'block text-sm font-medium text-gray-700';

export function SectionForm({
  type,
  initialContent,
  onSave,
  onCancel,
  pending = false,
}: SectionFormProps) {
  const [state, setState] = useState<SectionFormState>(() =>
    initialContent ? formStateFromContent(initialContent) : emptyFormStateFor(type),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (name: string, v: string) =>
    setState((prev) => ({ ...prev, [name]: v }));

  function submit() {
    const built = buildSectionContent(state);
    if (!built.ok) {
      setErrors(built.fieldErrors);
      return;
    }
    setErrors({});
    void onSave(built.content as Record<string, unknown>);
  }

  return (
    <div className="space-y-3">
      {SECTION_FIELD_SPECS[type].map((field) => (
        <FieldControl
          key={field.name}
          field={field}
          value={state[field.name] ?? ''}
          error={errors[field.name]}
          onChange={(v) => set(field.name, v)}
        />
      ))}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Сохранение…' : 'Сохранить секцию'}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-gray-600 hover:underline"
          >
            Отмена
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: SectionFieldSpec;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const errNode = error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null;

  return (
    <div>
      <label className={labelCls}>
        {field.label}
        {field.required ? '*' : ''}
      </label>

      {field.kind === 'richtext' ? (
        <div className="mt-1">
          <RichTextEditor value={value} onChange={onChange} ariaLabel={field.label} />
        </div>
      ) : field.kind === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'pairs' || field.kind === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={inputCls}
          placeholder={field.hint}
        />
      ) : field.kind === 'number' ? (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
          placeholder={field.hint}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
          placeholder={field.hint}
        />
      )}

      {field.hint && field.kind !== 'pairs' && field.kind !== 'number' ? (
        <p className="mt-1 text-xs text-gray-400">{field.hint}</p>
      ) : null}
      {errNode}
    </div>
  );
}
