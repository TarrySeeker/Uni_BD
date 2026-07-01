'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ATTRIBUTE_TYPES, type Attribute, type AttributeType } from '@/lib/catalog/types';

import { createAttributeAction, updateAttributeAction } from './form-actions';
import {
  buildAttributeCreatePayload,
  buildAttributeUpdatePayload,
} from './payload';
import { errorMessage, fieldError } from '../../_components/action-result';
import type { ActionResult } from '@/lib/server/action';

/**
 * Форма характеристики (docs/06 §4.5, F3 аудита). Создание/редактирование
 * метаданных характеристики. Мутации — createAttribute/updateAttribute
 * (catalog.write на сервере). Код характеристики (attributes.code) стабильный:
 * задаётся при создании и НЕ меняется при правке (по нему живут привязки).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const TYPE_LABELS: Record<AttributeType, string> = {
  select: 'Список значений (select)',
  text: 'Текст',
  number: 'Число',
  boolean: 'Да / нет',
};

export function AttributeForm({ attribute }: { attribute: Attribute | null }) {
  const router = useRouter();
  const isEdit = attribute !== null;

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [code, setCode] = useState(attribute?.code ?? '');
  const [name, setName] = useState(attribute?.name ?? '');
  const [type, setType] = useState<AttributeType>(attribute?.type ?? 'select');
  const [unit, setUnit] = useState(attribute?.unit ?? '');
  const [isVariant, setIsVariant] = useState(attribute?.isVariant ?? false);
  const [isFilterable, setIsFilterable] = useState(attribute?.isFilterable ?? true);
  const [isRequired, setIsRequired] = useState(attribute?.isRequired ?? false);
  const [sort, setSort] = useState(String(attribute?.sort ?? 0));

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const sortNum = Number.parseInt(sort, 10);
    const result = isEdit
      ? await updateAttributeAction(
          buildAttributeUpdatePayload(attribute!.id, {
            name,
            type,
            unit,
            isVariant,
            isFilterable,
            isRequired,
            sort: Number.isFinite(sortNum) ? sortNum : undefined,
          }),
        )
      : await createAttributeAction(
          buildAttributeCreatePayload({
            code,
            name,
            type,
            unit,
            isVariant,
            isFilterable,
            isRequired,
            sort: Number.isFinite(sortNum) ? sortNum : undefined,
          }),
        );
    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Изменения сохранены.');
        router.refresh();
      } else {
        router.push(`/admin/catalog/attributes/${result.data.id}`);
      }
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
          <label htmlFor="a-code" className="block text-sm font-medium text-gray-700">Код*</label>
          <input
            id="a-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isEdit}
            placeholder="например: color, size"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-500"
            required
          />
          <p className="mt-1 text-xs text-gray-500">
            Латиница в нижнем регистре, цифры и подчёркивание. {isEdit ? 'Изменить нельзя.' : 'Задаётся один раз.'}
          </p>
          {fe('code') ? <p className="mt-1 text-xs text-red-600">{fe('code')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-name" className="block text-sm font-medium text-gray-700">Название*</label>
          <input id="a-name" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="например: Цвет, Размер"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
          {fe('name') ? <p className="mt-1 text-xs text-red-600">{fe('name')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-type" className="block text-sm font-medium text-gray-700">Тип значения</label>
          <select id="a-type" value={type} onChange={(e) => setType(e.target.value as AttributeType)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            {ATTRIBUTE_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Для «Списка значений» словарь значений ниже; для остальных значение вводится у товара.
          </p>
          {fe('type') ? <p className="mt-1 text-xs text-red-600">{fe('type')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-unit" className="block text-sm font-medium text-gray-700">Единица измерения</label>
          <input id="a-unit" value={unit} onChange={(e) => setUnit(e.target.value)}
            placeholder="например: см, кг (необязательно)"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('unit') ? <p className="mt-1 text-xs text-red-600">{fe('unit')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-sort" className="block text-sm font-medium text-gray-700">Порядок (sort)</label>
          <input id="a-sort" type="number" min={0} value={sort} onChange={(e) => setSort(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('sort') ? <p className="mt-1 text-xs text-red-600">{fe('sort')}</p> : null}
        </div>
        <fieldset className="lg:col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <legend className="sr-only">Флаги характеристики</legend>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isVariant} onChange={(e) => setIsVariant(e.target.checked)} />
            Признак варианта
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isFilterable} onChange={(e) => setIsFilterable(e.target.checked)} />
            В фильтрах витрины
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
            Обязательная
          </label>
        </fieldset>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать характеристику'}
        </button>
        <button type="button" onClick={() => router.push('/admin/catalog/attributes')}
          className="text-sm text-gray-600 hover:underline">
          Отмена
        </button>
      </div>
    </div>
  );
}
