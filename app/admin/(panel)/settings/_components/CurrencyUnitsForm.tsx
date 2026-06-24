'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { updateCurrencyUnitsAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

/** Форма валюты и единиц измерения (docs/11 §5.4.5). */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function CurrencyUnitsForm({
  currency,
  units,
}: {
  currency: EffectiveSettings['currency'];
  units: EffectiveSettings['units'];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [code, setCode] = useState(currency.code);
  const [symbol, setSymbol] = useState(currency.symbol ?? '');
  const [locale, setLocale] = useState(currency.locale ?? '');
  const [fractionDigits, setFractionDigits] = useState(String(currency.fractionDigits));
  const [weight, setWeight] = useState(units.weight);
  const [dimension, setDimension] = useState(units.dimension);

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateCurrencyUnitsAction({
      currency: {
        code: code.trim() || undefined,
        symbol: symbol.trim() || undefined,
        locale: locale.trim() || undefined,
        fractionDigits: fractionDigits.trim() ? Number(fractionDigits) : undefined,
      },
      units: { weight, dimension, system: 'metric' },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Валюта и единицы сохранены.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, f);

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
          <label htmlFor="c-code" className="block text-sm font-medium text-gray-700">Код валюты</label>
          <input id="c-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={3} placeholder="RUB" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-500">3 латинские буквы: RUB — рубль, USD — доллар, EUR — евро.</p>
          {fe('currency.code') ? <p className="mt-1 text-xs text-red-600">{fe('currency.code')}</p> : null}
        </div>
        <div>
          <label htmlFor="c-symbol" className="block text-sm font-medium text-gray-700">Символ</label>
          <input id="c-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}
            placeholder="₽" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="c-locale" className="block text-sm font-medium text-gray-700">Формат чисел</label>
          <input id="c-locale" value={locale} onChange={(e) => setLocale(e.target.value)}
            placeholder="ru-RU" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-500">Как разделять разряды и дробную часть. <code>ru-RU</code> — как принято в России.</p>
        </div>
        <div>
          <label htmlFor="c-frac" className="block text-sm font-medium text-gray-700">Знаков после запятой</label>
          <input id="c-frac" type="number" min={0} max={4} value={fractionDigits}
            onChange={(e) => setFractionDigits(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="u-weight" className="block text-sm font-medium text-gray-700">Единица веса</label>
          <select id="u-weight" value={weight} onChange={(e) => setWeight(e.target.value as typeof weight)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="g">граммы (g)</option>
            <option value="kg">килограммы (kg)</option>
          </select>
        </div>
        <div>
          <label htmlFor="u-dim" className="block text-sm font-medium text-gray-700">Единица габаритов</label>
          <select id="u-dim" value={dimension} onChange={(e) => setDimension(e.target.value as typeof dimension)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="cm">сантиметры (cm)</option>
            <option value="mm">миллиметры (mm)</option>
          </select>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
