'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  PROMO_KINDS,
  PROMO_APPLY_SCOPES,
  PROMO_TARGET_TYPES,
} from '@/lib/orders/types';
import type { PromoCode, PromoTarget, PromoTargetType } from '@/lib/orders/types';
import { promoKindLabel, promoScopeLabel } from '@/lib/admin/order-format';
import type { ActionResult } from '@/lib/server/action';

import {
  createPromoCodeAction,
  updatePromoCodeAction,
} from '../../orders/_components/order-actions';
import { errorMessage, fieldError } from '../../orders/_components/action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Форма промокода (docs/07 §5, docs/11 §5.2.5): создание/редактирование. Поля:
 * код, тип (percent/fixed/free_delivery/bogo), значение, условия (мин.сумма,
 * потолок, лимиты), срок, активность, bogo N/M. N×M-механики (Пакет 5.P-2):
 * applyScope (radio), таргеты (мультиселект по типу+id при scope≠cart), priority,
 * stackable, minQty. Блок «Подарок» (gift_*) — за UI-фичефлагом (по умолчанию
 * скрыт до реализации gift-kind). Бизнес-валидация — в Zod-схемах/actions на
 * сервере (RBAC orders.write); здесь только сбор значений и отображение ошибок.
 */

/** Фичефлаг UI блока «Подарок» (gift_*) — скрыт по умолчанию (исполнение отложено). */
const SHOW_GIFT_BLOCK = false;

/** Дата для <input type="date"> (YYYY-MM-DD) из Date | null. */
function toDateInput(d: Date | null): string {
  if (!d) return '';
  const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  return iso.slice(0, 10);
}

/** Число из строки поля или undefined для пустого. */
function numOrUndef(v: string): number | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Строка редактируемого таргета в форме (тип + id-значение). */
interface TargetRow {
  targetType: PromoTargetType;
  /** UUID выбранной сущности соответствующего типа. */
  id: string;
}

/** PromoTarget (домен) → строка формы. */
function targetToRow(t: PromoTarget): TargetRow {
  const id =
    t.categoryId ?? t.brandId ?? t.productId ?? t.variantId ?? '';
  return { targetType: t.targetType, id };
}

/** Строка формы → payload-таргет (ровно одно *_id по типу). */
function rowToTargetPayload(r: TargetRow): Record<string, unknown> {
  const base: Record<string, unknown> = { targetType: r.targetType };
  const key =
    r.targetType === 'category'
      ? 'categoryId'
      : r.targetType === 'brand'
        ? 'brandId'
        : r.targetType === 'product'
          ? 'productId'
          : 'variantId';
  base[key] = r.id.trim();
  return base;
}

const TARGET_TYPE_LABEL: Record<PromoTargetType, string> = {
  category: 'Категория',
  brand: 'Бренд',
  product: 'Товар',
  variant: 'Вариант',
};

/** Списки сущностей для выбора таргета по названию (вместо ввода UUID). */
export type PromoPickerData = Partial<
  Record<PromoTargetType, { id: string; name: string }[]>
>;

export function PromoForm({
  promo,
  targets = [],
  pickerData = {},
}: {
  promo: PromoCode | null;
  targets?: PromoTarget[];
  pickerData?: PromoPickerData;
}) {
  const router = useRouter();
  const isEdit = promo !== null;

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [code, setCode] = useState(promo?.code ?? '');
  const [kind, setKind] = useState(promo?.kind ?? 'percent');
  const [value, setValue] = useState(promo?.value ?? '0');
  const [minOrderTotal, setMinOrderTotal] = useState(promo?.minOrderTotal ?? '0');
  const [maxDiscount, setMaxDiscount] = useState(promo?.maxDiscount ?? '');
  const [usageLimit, setUsageLimit] = useState(
    promo?.usageLimit != null ? String(promo.usageLimit) : '',
  );
  const [perCustomerLimit, setPerCustomerLimit] = useState(
    promo?.perCustomerLimit != null ? String(promo.perCustomerLimit) : '',
  );
  const [startsAt, setStartsAt] = useState(toDateInput(promo?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toDateInput(promo?.endsAt ?? null));
  const [isActive, setIsActive] = useState(promo?.isActive ?? true);
  const [bogoBuyQty, setBogoBuyQty] = useState(
    promo?.bogoBuyQty != null ? String(promo.bogoBuyQty) : '',
  );
  const [bogoPayQty, setBogoPayQty] = useState(
    promo?.bogoPayQty != null ? String(promo.bogoPayQty) : '',
  );
  const [comment, setComment] = useState(promo?.comment ?? '');

  // ---- N×M промо-механики (Пакет 5.P-2) ----
  const [applyScope, setApplyScope] = useState(promo?.applyScope ?? 'cart');
  const [priority, setPriority] = useState(
    promo?.priority != null ? String(promo.priority) : '100',
  );
  const [stackable, setStackable] = useState(promo?.stackable ?? false);
  const [minQty, setMinQty] = useState(promo?.minQty != null ? String(promo.minQty) : '');
  const [targetRows, setTargetRows] = useState<TargetRow[]>(
    targets.map(targetToRow),
  );
  const [giftProductId, setGiftProductId] = useState(promo?.giftProductId ?? '');
  const [giftVariantId, setGiftVariantId] = useState(promo?.giftVariantId ?? '');
  const [giftQty, setGiftQty] = useState(promo?.giftQty != null ? String(promo.giftQty) : '');

  function addTargetRow() {
    setTargetRows((rows) => [...rows, { targetType: 'category', id: '' }]);
  }
  function updateTargetRow(i: number, patch: Partial<TargetRow>) {
    setTargetRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeTargetRow(i: number) {
    setTargetRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);

    const targetsPayload =
      applyScope === 'cart'
        ? []
        : targetRows.filter((r) => r.id.trim() !== '').map(rowToTargetPayload);

    const payload = {
      code: code.trim(),
      kind,
      value: value.trim() || '0',
      minOrderTotal: minOrderTotal.trim() || '0',
      maxDiscount: maxDiscount.trim() || null,
      usageLimit: numOrUndef(usageLimit) ?? null,
      perCustomerLimit: numOrUndef(perCustomerLimit) ?? null,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      isActive,
      bogoBuyQty: numOrUndef(bogoBuyQty) ?? null,
      bogoPayQty: numOrUndef(bogoPayQty) ?? null,
      applyScope,
      priority: numOrUndef(priority) ?? 100,
      stackable,
      minQty: numOrUndef(minQty) ?? null,
      targets: targetsPayload,
      // БАГ #8 (аудит волны 15): когда UI-блок «Подарок» СКРЫТ (фичефлаг off, дефолт),
      // НЕ затираем подарок — сохраняем существующее значение редактируемого промокода
      // (иначе любое редактирование молча стирало бы gift_*). Для нового промокода
      // promo === undefined → null (подарка нет). При показанном блоке — из формы.
      giftProductId: SHOW_GIFT_BLOCK ? giftProductId.trim() || null : (promo?.giftProductId ?? null),
      giftVariantId: SHOW_GIFT_BLOCK ? giftVariantId.trim() || null : (promo?.giftVariantId ?? null),
      giftQty: SHOW_GIFT_BLOCK ? numOrUndef(giftQty) ?? null : (promo?.giftQty ?? null),
      comment,
    };

    const result = isEdit
      ? await updatePromoCodeAction({ id: promo!.id, ...payload })
      : await createPromoCodeAction(payload);

    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess('Изменения сохранены.');
        router.refresh();
      } else {
        router.push('/admin/promo');
      }
    } else {
      setError(result);
    }
  }

  function fe(f: string) {
    return fieldError(error, f);
  }

  const showBogo = kind === 'bogo';
  const showPercentHint = kind === 'percent';
  const showTargets = applyScope !== 'cart';

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="p-code" className="block text-sm font-medium text-gray-700">Код*</label>
          <input id="p-code" value={code} onChange={(e) => setCode(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" required />
          {fe('code') ? <p className="mt-1 text-xs text-red-600">{fe('code')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-kind" className="block text-sm font-medium text-gray-700">Тип*</label>
          <select id="p-kind" value={kind} onChange={(e) => setKind(e.target.value as PromoCode['kind'])}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            {PROMO_KINDS.map((k) => (
              <option key={k} value={k}>{promoKindLabel(k)}</option>
            ))}
          </select>
          {fe('kind') ? <p className="mt-1 text-xs text-red-600">{fe('kind')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-value" className="block text-sm font-medium text-gray-700">
            Значение {showPercentHint ? '(проценты 0..100)' : kind === 'fixed' ? '(сумма)' : ''}
          </label>
          <input id="p-value" value={value} onChange={(e) => setValue(e.target.value)}
            inputMode="decimal" disabled={kind === 'free_delivery'}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100" />
          {fe('value') ? <p className="mt-1 text-xs text-red-600">{fe('value')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-min" className="block text-sm font-medium text-gray-700">Мин. сумма заказа</label>
          <input id="p-min" value={minOrderTotal} onChange={(e) => setMinOrderTotal(e.target.value)}
            inputMode="decimal"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('minOrderTotal') ? <p className="mt-1 text-xs text-red-600">{fe('minOrderTotal')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-maxdisc" className="block text-sm font-medium text-gray-700">Потолок скидки (для percent)</label>
          <input id="p-maxdisc" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)}
            inputMode="decimal" placeholder="без потолка"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('maxDiscount') ? <p className="mt-1 text-xs text-red-600">{fe('maxDiscount')}</p> : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="p-usage" className="block text-sm font-medium text-gray-700">Лимит всего</label>
            <input id="p-usage" value={usageLimit} onChange={(e) => setUsageLimit(e.target.value)}
              inputMode="numeric" placeholder="∞"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="p-percust" className="block text-sm font-medium text-gray-700">На покупателя</label>
            <input id="p-percust" value={perCustomerLimit} onChange={(e) => setPerCustomerLimit(e.target.value)}
              inputMode="numeric" placeholder="∞"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div>
          <label htmlFor="p-starts" className="block text-sm font-medium text-gray-700">Начало</label>
          <input id="p-starts" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="p-ends" className="block text-sm font-medium text-gray-700">Окончание</label>
          <input id="p-ends" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('endsAt') ? <p className="mt-1 text-xs text-red-600">{fe('endsAt')}</p> : null}
        </div>

        {showBogo ? (
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <div>
              <label htmlFor="p-bogo-buy" className="block text-sm font-medium text-gray-700">Купи N</label>
              <input id="p-bogo-buy" value={bogoBuyQty} onChange={(e) => setBogoBuyQty(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {fe('bogoBuyQty') ? <p className="mt-1 text-xs text-red-600">{fe('bogoBuyQty')}</p> : null}
            </div>
            <div>
              <label htmlFor="p-bogo-pay" className="block text-sm font-medium text-gray-700">Плати за M</label>
              <input id="p-bogo-pay" value={bogoPayQty} onChange={(e) => setBogoPayQty(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              {fe('bogoPayQty') ? <p className="mt-1 text-xs text-red-600">{fe('bogoPayQty')}</p> : null}
            </div>
            <p className="text-xs text-gray-500 sm:col-span-2">
              Например «3 по 2»: купи N=3, плати за M=2 → 1 самая дешёвая бесплатно.
            </p>
          </div>
        ) : null}

        {/* ---- N×M: scope / приоритет / комбинируемость / minQty ---- */}
        <fieldset className="rounded border border-gray-200 p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-gray-700">Область применения</legend>
          <div role="radiogroup" aria-label="Область применения" className="flex flex-wrap gap-4">
            {PROMO_APPLY_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="applyScope"
                  value={s}
                  checked={applyScope === s}
                  onChange={() => setApplyScope(s)}
                />
                {promoScopeLabel(s)}
              </label>
            ))}
          </div>
          {fe('applyScope') ? <p className="mt-1 text-xs text-red-600">{fe('applyScope')}</p> : null}

          {showTargets ? (
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-700">Таргеты акции</p>
              <p className="mb-2 text-xs text-gray-500">
                Выберите, к чему применяется акция: тип (категория / бренд / товар) и саму
                сущность из списка.
              </p>
              {targetRows.length === 0 ? (
                <p className="text-xs text-gray-400">Таргетов нет — добавьте хотя бы один.</p>
              ) : null}
              <ul className="space-y-2">
                {targetRows.map((row, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`tgt-type-${i}`}>Тип таргета {i + 1}</label>
                    <select
                      id={`tgt-type-${i}`}
                      value={row.targetType}
                      onChange={(e) => updateTargetRow(i, { targetType: e.target.value as PromoTargetType })}
                      className="rounded border border-gray-300 px-2 py-1.5 text-sm"
                    >
                      {PROMO_TARGET_TYPES.map((tt) => (
                        <option key={tt} value={tt}>{TARGET_TYPE_LABEL[tt]}</option>
                      ))}
                    </select>
                    <label className="sr-only" htmlFor={`tgt-id-${i}`}>Сущность таргета {i + 1}</label>
                    {pickerData[row.targetType] ? (
                      <select
                        id={`tgt-id-${i}`}
                        value={row.id}
                        onChange={(e) => updateTargetRow(i, { id: e.target.value })}
                        className="min-w-[18rem] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                      >
                        <option value="">— выберите —</option>
                        {pickerData[row.targetType]!.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`tgt-id-${i}`}
                        value={row.id}
                        onChange={(e) => updateTargetRow(i, { id: e.target.value })}
                        placeholder="идентификатор"
                        className="min-w-[18rem] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeTargetRow(i)}
                      className="text-sm text-red-600 hover:underline"
                      aria-label={`Удалить таргет ${i + 1}`}
                    >
                      Удалить
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={addTargetRow}
                className="mt-2 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                + Добавить таргет
              </button>
              {fe('targets') ? <p className="mt-1 text-xs text-red-600">{fe('targets')}</p> : null}
            </div>
          ) : null}
        </fieldset>

        <div>
          <label htmlFor="p-priority" className="block text-sm font-medium text-gray-700">
            Очерёдность применения (меньше — раньше)
          </label>
          <input id="p-priority" value={priority} onChange={(e) => setPriority(e.target.value)}
            inputMode="numeric"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('priority') ? <p className="mt-1 text-xs text-red-600">{fe('priority')}</p> : null}
        </div>

        <div>
          <label htmlFor="p-minqty" className="block text-sm font-medium text-gray-700">
            Мин. количество единиц
          </label>
          <input id="p-minqty" value={minQty} onChange={(e) => setMinQty(e.target.value)}
            inputMode="numeric" placeholder="без порога"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('minQty') ? <p className="mt-1 text-xs text-red-600">{fe('minQty')}</p> : null}
        </div>

        {SHOW_GIFT_BLOCK ? (
          <fieldset className="rounded border border-gray-200 p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-medium text-gray-700">Подарок (задел)</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="p-gift-prod" className="block text-sm text-gray-700">Товар-подарок (UUID)</label>
                <input id="p-gift-prod" value={giftProductId} onChange={(e) => setGiftProductId(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label htmlFor="p-gift-var" className="block text-sm text-gray-700">Вариант-подарок (UUID)</label>
                <input id="p-gift-var" value={giftVariantId} onChange={(e) => setGiftVariantId(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label htmlFor="p-gift-qty" className="block text-sm text-gray-700">Кол-во</label>
                <input id="p-gift-qty" value={giftQty} onChange={(e) => setGiftQty(e.target.value)}
                  inputMode="numeric"
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
              </div>
            </div>
          </fieldset>
        ) : null}

        <div className="sm:col-span-2">
          <label htmlFor="p-comment" className="block text-sm font-medium text-gray-700">Комментарий</label>
          <textarea id="p-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Активен
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
          Суммируемая (комбинируется с другими)
        </label>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать промокод'}
        </button>
        <button type="button" onClick={() => router.push('/admin/promo')}
          className="text-sm text-gray-600 hover:underline">
          Отмена
        </button>
      </div>
    </div>
  );
}
