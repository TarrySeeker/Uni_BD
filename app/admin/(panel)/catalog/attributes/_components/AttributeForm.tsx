'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

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

export function AttributeForm({ attribute }: { attribute: Attribute | null }) {
  const router = useRouter();
  const t = useTranslations();
  const isEdit = attribute !== null;

  const typeLabels: Record<AttributeType, string> = {
    select: t('catalog.attribute.types.select'),
    text: t('catalog.attribute.types.text'),
    number: t('catalog.attribute.types.number'),
    boolean: t('catalog.attribute.types.boolean'),
  };

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
        setSuccess(t('catalog.common.savedChanges'));
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
          <label htmlFor="a-code" className="block text-sm font-medium text-gray-700">{t('catalog.attribute.fields.code')}*</label>
          <input
            id="a-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isEdit}
            placeholder={t('catalog.attribute.placeholders.code')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-500"
            required
          />
          <p className="mt-1 text-xs text-gray-500">
            {t('catalog.attribute.help.code')} {isEdit ? t('catalog.attribute.help.codeLocked') : t('catalog.attribute.help.codeOnce')}
          </p>
          {fe('code') ? <p className="mt-1 text-xs text-red-600">{fe('code')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-name" className="block text-sm font-medium text-gray-700">{t('fields.name')}*</label>
          <input id="a-name" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t('catalog.attribute.placeholders.name')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
          {fe('name') ? <p className="mt-1 text-xs text-red-600">{fe('name')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-type" className="block text-sm font-medium text-gray-700">{t('catalog.attribute.fields.type')}</label>
          <select id="a-type" value={type} onChange={(e) => setType(e.target.value as AttributeType)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            {ATTRIBUTE_TYPES.map((at) => (
              <option key={at} value={at}>{typeLabels[at]}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {t('catalog.attribute.help.type')}
          </p>
          {fe('type') ? <p className="mt-1 text-xs text-red-600">{fe('type')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-unit" className="block text-sm font-medium text-gray-700">{t('catalog.attribute.fields.unit')}</label>
          <input id="a-unit" value={unit} onChange={(e) => setUnit(e.target.value)}
            placeholder={t('catalog.attribute.placeholders.unit')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('unit') ? <p className="mt-1 text-xs text-red-600">{fe('unit')}</p> : null}
        </div>
        <div>
          <label htmlFor="a-sort" className="block text-sm font-medium text-gray-700">{t('catalog.attribute.fields.sort')}</label>
          <input id="a-sort" type="number" min={0} value={sort} onChange={(e) => setSort(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('sort') ? <p className="mt-1 text-xs text-red-600">{fe('sort')}</p> : null}
        </div>
        <fieldset className="lg:col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <legend className="sr-only">{t('catalog.attribute.flagsLegend')}</legend>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isVariant} onChange={(e) => setIsVariant(e.target.checked)} />
            {t('catalog.attribute.flags.variant')}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isFilterable} onChange={(e) => setIsFilterable(e.target.checked)} />
            {t('catalog.attribute.flags.filterable')}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
            {t('catalog.attribute.flags.required')}
          </label>
        </fieldset>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" data-testid="attribute-submit" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : isEdit ? t('common.actions.save') : t('catalog.attribute.createButton')}
        </button>
        <button type="button" onClick={() => router.push('/admin/catalog/attributes')}
          className="text-sm text-gray-600 hover:underline">
          {t('common.actions.cancel')}
        </button>
      </div>
    </div>
  );
}
