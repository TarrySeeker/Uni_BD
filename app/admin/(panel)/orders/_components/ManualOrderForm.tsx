'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

import { formatPrice } from '@/lib/admin/format';
import {
  buildManualOrderPayload,
  createdOrderPath,
  estimateItemsTotal,
  mapCreateOrderResponse,
  type EstimateLine,
  type ManualOrderFormState,
} from '@/lib/orders/manual-order-form';
import type { OrderProductOption } from '@/lib/orders/product-search';
import type { DeliveryType, PaymentMethod } from '@/lib/orders/types';
import type { ActionResult } from '@/lib/server/action';

import { errorMessage, fieldError } from './action-result';
import {
  createManualOrderAction,
  searchProductsForOrderAction,
} from './order-actions';

/**
 * Форма ручного создания заказа из админки (Batch 4, F4) для НЕтехнического
 * владельца. Шаги: подобрать товары (поиск → выбор товара/варианта → кол-во,
 * с предпросмотром цены и промежуточного итога), указать покупателя, способ
 * доставки и адрес/ПВЗ, комментарий. Сабмит → createManualOrderAction; при успехе
 * редирект на карточку заказа. Деньги/итог считает СЕРВЕР (ADR-010) — здесь только
 * подсказка-предпросмотр.
 *
 * Состояние — useState; вызовы экшенов — в useTransition (React 19): isPending
 * блокирует кнопки. Ошибки валидации показываются у полей (fieldErrors), доменные
 * ошибки (нет остатка, и т.п.) — общим алертом (errorMessage).
 */

type FailResult = Extract<ActionResult<unknown>, { ok: false }>;

interface Option {
  value: string;
  label: string;
}

/** Позиция в состоянии формы + выбранный товар (для предпросмотра цены). */
interface FormLine {
  /** Локальный ключ строки (для React key / удаления). */
  key: string;
  product: OrderProductOption | null;
  /** Выбранный вариант (если у товара есть варианты); пусто — товар без вариантов. */
  variantId: string;
  qty: number;
}

let lineSeq = 0;
function newLine(): FormLine {
  lineSeq += 1;
  return { key: `line-${lineSeq}`, product: null, variantId: '', qty: 1 };
}

/** Цена выбранной позиции за единицу (строка-сумма) для предпросмотра. */
function lineUnitPrice(line: FormLine): string | null {
  if (!line.product) return null;
  if (line.product.variants.length > 0) {
    const v = line.product.variants.find((x) => x.variantId === line.variantId);
    return v ? v.unitPrice : null;
  }
  return line.product.unitPrice;
}

/** Строки для оценки промежуточного итога (UI-подсказка). */
function toEstimateLines(lines: FormLine[]): EstimateLine[] {
  const out: EstimateLine[] = [];
  for (const line of lines) {
    const unit = lineUnitPrice(line);
    if (unit === null) continue;
    // Подаём готовую эффективную цену как basePrice без override/delta — итог = unit×qty.
    out.push({ basePrice: unit, qty: line.qty });
  }
  return out;
}

export function ManualOrderForm({
  currency,
  paymentOptions,
  deliveryOptions,
}: {
  currency: string;
  paymentOptions: Option[];
  deliveryOptions: Option[];
}) {
  const router = useRouter();
  const baseId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<FailResult | null>(null);

  // --- Позиции -----------------------------------------------------------------
  const [lines, setLines] = useState<FormLine[]>([newLine()]);

  // --- Поиск товаров -----------------------------------------------------------
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<OrderProductOption[]>([]);
  const [searchTouched, setSearchTouched] = useState(false);

  // --- Покупатель --------------------------------------------------------------
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // --- Доставка ----------------------------------------------------------------
  const [deliveryType, setDeliveryType] = useState<DeliveryType>(
    (deliveryOptions[0]?.value as DeliveryType) ?? 'courier',
  );
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [pvzCode, setPvzCode] = useState('');

  // --- Оплата / комментарий ----------------------------------------------------
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    (paymentOptions.find((o) => o.value === 'cod')?.value as PaymentMethod) ??
      (paymentOptions[0]?.value as PaymentMethod) ??
      'unset',
  );
  const [comment, setComment] = useState('');

  const fe = (f: string): string | undefined => fieldError(error, f);

  function runSearch() {
    setSearchTouched(true);
    setSearching(true);
    startTransition(async () => {
      try {
        const res = await searchProductsForOrderAction({ q: search.trim() || undefined });
        if (res.ok) {
          setResults(res.data.products);
        } else {
          setResults([]);
          setError(res);
        }
      } catch {
        setResults([]);
        setError({ ok: false, error: 'internal' });
      } finally {
        setSearching(false);
      }
    });
  }

  /** Добавить товар из результатов поиска в первую пустую строку (или новую). */
  function addProduct(product: OrderProductOption) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.product === null);
      const filled: FormLine = {
        ...(idx >= 0 ? prev[idx]! : newLine()),
        product,
        variantId: product.variants[0]?.variantId ?? '',
        qty: 1,
      };
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = filled;
        return next;
      }
      return [...prev, filled];
    });
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      return next.length > 0 ? next : [newLine()];
    });
  }

  /** Текущее состояние формы → ManualOrderFormState для сборки payload. */
  function toFormState(): ManualOrderFormState {
    return {
      items: lines.map((l) => {
        const hasVariants = (l.product?.variants.length ?? 0) > 0;
        return {
          productId: l.product && !hasVariants ? l.product.productId : undefined,
          variantId: hasVariants ? l.variantId || undefined : undefined,
          qty: l.qty,
        };
      }),
      customer: { name, email, phone },
      delivery: { type: deliveryType, city, address, pvzCode },
      paymentMethod,
      comment,
    };
  }

  function onSubmit() {
    setError(null);
    const payload = buildManualOrderPayload(toFormState());
    startTransition(async () => {
      try {
        const res = await createManualOrderAction(payload);
        if (res.ok) {
          const mapped = mapCreateOrderResponse(res.data);
          router.push(createdOrderPath(mapped.id));
        } else {
          setError(res);
        }
      } catch {
        setError({ ok: false, error: 'internal' });
      }
    });
  }

  const estimate = estimateItemsTotal(toEstimateLines(lines));
  const hasAnyItem = lines.some((l) => l.product !== null);

  return (
    <div className="space-y-8">
      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}

      {/* ---- Поиск и подбор товаров ------------------------------------------ */}
      <section aria-labelledby={`${baseId}-items`} className="rounded-lg border border-gray-200 p-4">
        <h2 id={`${baseId}-items`} className="text-lg font-semibold text-gray-900">
          Товары
        </h2>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[240px]">
            <label htmlFor={`${baseId}-search`} className="block text-sm font-medium text-gray-700">
              Поиск товара (название или артикул)
            </label>
            <input
              id={`${baseId}-search`}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch();
                }
              }}
              placeholder="Например: футболка или TC-001"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={runSearch}
            disabled={pending || searching}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {searching ? 'Поиск…' : 'Найти'}
          </button>
        </div>

        {searchTouched ? (
          <div className="mt-3">
            {results.length === 0 ? (
              <p className="text-sm text-gray-400">
                {searching ? 'Ищем товары…' : 'Ничего не найдено. Измените запрос.'}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {results.map((p) => (
                  <li key={p.productId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium text-gray-900">{p.name}</span>{' '}
                      <span className="text-gray-400">({p.sku})</span>
                      <div className="text-xs text-gray-500">
                        {p.variants.length > 0
                          ? `Вариантов: ${p.variants.length}`
                          : `${formatPrice(p.unitPrice, currency)} · доступно ${p.availableStock}`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addProduct(p)}
                      className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                    >
                      Добавить
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {/* ---- Список выбранных позиций -------------------------------------- */}
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th scope="col" className="py-2 font-medium">Товар</th>
                <th scope="col" className="py-2 font-medium">Вариант</th>
                <th scope="col" className="py-2 font-medium">Кол-во</th>
                <th scope="col" className="py-2 font-medium">Цена</th>
                <th scope="col" className="py-2 font-medium">Сумма</th>
                <th scope="col" className="py-2 font-medium" aria-label="Действия" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((line) => {
                const unit = lineUnitPrice(line);
                const sum =
                  unit !== null ? estimateItemsTotal([{ basePrice: unit, qty: line.qty }]) : null;
                return (
                  <tr key={line.key}>
                    <td className="py-2 pr-3 align-top">
                      {line.product ? (
                        <div>
                          <div className="font-medium text-gray-900">{line.product.name}</div>
                          <div className="text-xs text-gray-400">{line.product.sku}</div>
                        </div>
                      ) : (
                        <span className="text-gray-400">— выберите товар через поиск —</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      {line.product && line.product.variants.length > 0 ? (
                        <select
                          aria-label="Вариант товара"
                          value={line.variantId}
                          onChange={(e) => updateLine(line.key, { variantId: e.target.value })}
                          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                        >
                          {line.product.variants.map((v) => (
                            <option key={v.variantId} value={v.variantId}>
                              {v.name} ({formatPrice(v.unitPrice, currency)})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <input
                        type="number"
                        min={1}
                        max={10000}
                        step={1}
                        aria-label="Количество"
                        value={line.qty}
                        onChange={(e) =>
                          updateLine(line.key, {
                            qty: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                          })
                        }
                        className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm"
                      />
                    </td>
                    <td className="py-2 pr-3 align-top text-gray-700">
                      {unit !== null ? formatPrice(unit, currency) : '—'}
                    </td>
                    <td className="py-2 pr-3 align-top font-medium text-gray-900">
                      {sum !== null ? formatPrice(sum, currency) : '—'}
                    </td>
                    <td className="py-2 align-top text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, newLine()])}
            className="text-sm text-blue-700 hover:underline"
          >
            + Добавить пустую строку
          </button>
          <div className="text-sm text-gray-600">
            Промежуточный итог (предпросмотр):{' '}
            <span className="font-semibold text-gray-900">{formatPrice(estimate, currency)}</span>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Итог, скидки и доставку рассчитает сервер при создании заказа.
        </p>
        {fe('items') ? <p className="mt-1 text-sm text-red-600">{fe('items')}</p> : null}
      </section>

      {/* ---- Покупатель ----------------------------------------------------- */}
      <section aria-labelledby={`${baseId}-customer`} className="rounded-lg border border-gray-200 p-4">
        <h2 id={`${baseId}-customer`} className="text-lg font-semibold text-gray-900">
          Покупатель
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Field
            id={`${baseId}-name`}
            label="Имя"
            value={name}
            onChange={setName}
            error={fe('customer.name')}
            required
          />
          <Field
            id={`${baseId}-phone`}
            label="Телефон"
            value={phone}
            onChange={setPhone}
            error={fe('customer.phone')}
            required
          />
          <Field
            id={`${baseId}-email`}
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            error={fe('customer.email')}
            required
          />
        </div>
      </section>

      {/* ---- Доставка ------------------------------------------------------- */}
      <section aria-labelledby={`${baseId}-delivery`} className="rounded-lg border border-gray-200 p-4">
        <h2 id={`${baseId}-delivery`} className="text-lg font-semibold text-gray-900">
          Доставка
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${baseId}-dtype`} className="block text-sm font-medium text-gray-700">
              Способ доставки
            </label>
            <select
              id={`${baseId}-dtype`}
              value={deliveryType}
              onChange={(e) => setDeliveryType(e.target.value as DeliveryType)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {deliveryOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {deliveryType !== 'pickup' ? (
            <Field
              id={`${baseId}-city`}
              label="Город"
              value={city}
              onChange={setCity}
              error={fe('delivery.city')}
            />
          ) : null}

          {deliveryType === 'courier' ? (
            <Field
              id={`${baseId}-address`}
              label="Адрес"
              value={address}
              onChange={setAddress}
              error={fe('delivery.address')}
              className="sm:col-span-2"
            />
          ) : null}

          {deliveryType === 'pvz' ? (
            <Field
              id={`${baseId}-pvz`}
              label="Код ПВЗ (СДЭК)"
              value={pvzCode}
              onChange={setPvzCode}
              error={fe('delivery.pvzCode')}
              required
            />
          ) : null}
        </div>
        {deliveryType === 'pickup' ? (
          <p className="mt-2 text-sm text-gray-500">Самовывоз: адрес и ПВЗ не требуются.</p>
        ) : null}
      </section>

      {/* ---- Оплата и комментарий ------------------------------------------ */}
      <section aria-labelledby={`${baseId}-payment`} className="rounded-lg border border-gray-200 p-4">
        <h2 id={`${baseId}-payment`} className="text-lg font-semibold text-gray-900">
          Оплата и комментарий
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${baseId}-pay`} className="block text-sm font-medium text-gray-700">
              Способ оплаты
            </label>
            <select
              id={`${baseId}-pay`}
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {paymentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {fe('paymentMethod') ? (
              <p className="mt-1 text-sm text-red-600">{fe('paymentMethod')}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor={`${baseId}-comment`} className="block text-sm font-medium text-gray-700">
              Комментарий (необязательно)
            </label>
            <textarea
              id={`${baseId}-comment`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </section>

      {/* ---- Действия ------------------------------------------------------- */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || !hasAnyItem}
          className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Создаём заказ…' : 'Создать заказ'}
        </button>
        {!hasAnyItem ? (
          <span className="text-sm text-gray-400">Добавьте хотя бы один товар.</span>
        ) : null}
      </div>
    </div>
  );
}

/** Унифицированное текстовое поле с подписью и ошибкой (a11y: label+aria-invalid). */
function Field({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  required = false,
  className = '',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
