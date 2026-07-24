'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { CURRENCY_CATALOG, availableToAdd } from '@/lib/exchange/catalog';

import { updateCurrencyUnitsAction, refreshExchangeRatesAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';
import {
  applyServerRates,
  ratesSignature,
  rowsFromServer,
  type DisplayCurrencyRow,
} from './currency-form-state';

/** Форма валюты, курсов доп.валют (мультивалюта) и единиц измерения (docs/11 §5.4.5). */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function CurrencyUnitsForm({
  currency,
  exchange,
  units,
}: {
  currency: EffectiveSettings['currency'];
  exchange: EffectiveSettings['exchange'];
  units: EffectiveSettings['units'];
}) {
  const t = useTranslations();
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

  // Мультивалюта: доп.валюты отображения (₽/€) + авто-курс с ЦБ РФ.
  const [autoRate, setAutoRate] = useState(exchange.autoRate);
  const [rows, setRows] = useState<DisplayCurrencyRow[]>(() =>
    rowsFromServer(exchange.displayCurrencies),
  );

  // ПЕРЕСЕВ КУРСОВ ПОСЛЕ РУЧНОГО ОБНОВЛЕНИЯ С ЦБ.
  // router.refresh() перерисовывает серверную страницу, но состояние клиентской
  // формы React сохраняет: без пересева владелец видел бы старые курсы, а
  // «Сохранить» вернуло бы их в БД поверх только что полученных свежих.
  // Пересев не безусловный: он ждёт (а) явного нажатия кнопки обновления и
  // (б) реально изменившегося серверного снимка — и накладывает только курсы
  // автоматических валют, не трогая несохранённые правки владельца.
  const serverSignature = ratesSignature(exchange.displayCurrencies);
  const [seenSignature, setSeenSignature] = useState(serverSignature);
  const [awaitingServerRates, setAwaitingServerRates] = useState(false);
  if (serverSignature !== seenSignature) {
    // setState во время рендера — штатный приём React для подстройки под новые пропсы.
    setSeenSignature(serverSignature);
    if (awaitingServerRates) {
      setAwaitingServerRates(false);
      setRows((prev) => applyServerRates(prev, exchange.displayCurrencies));
    }
  }
  // Что выбрано в списке «добавить валюту». Список — справочник ПЛАТФОРМЫ
  // (lib/exchange/catalog), а не хардкод под конкретный магазин.
  const addable = availableToAdd(code, rows.map((r) => r.code));
  const [addCode, setAddCode] = useState(addable[0]?.code ?? '');
  // Выбранная валюта могла быть добавлена/базовая — тогда откатываемся на первую
  // доступную, иначе кнопка добавила бы дубль.
  const effectiveAddCode = addable.some((c) => c.code === addCode)
    ? addCode
    : (addable[0]?.code ?? '');

  function setRow(i: number, patch: Partial<DisplayCurrencyRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const picked = CURRENCY_CATALOG.find((c) => c.code === effectiveAddCode);
    if (!picked) return;
    setRows((prev) => [
      ...prev,
      {
        code: picked.code,
        symbol: picked.symbol,
        rate: '',
        fractionDigits: String(picked.fractionDigits),
        manualRate: false,
        rateUpdatedAt: null,
      },
    ]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  /** Ручной запуск обновления курсов с ЦБ (не ждать ночного крона). */
  async function refreshRates() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await refreshExchangeRatesAction({});
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.currencyUnitsForm.refreshSuccess'));
      // Взводим пересев: свежие курсы придут новыми пропсами после refresh.
      setAwaitingServerRates(true);
      router.refresh();
    } else {
      setError(result);
    }
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    // Сохранение отправляет на сервер то, что в форме: ждать от него чужих курсов
    // незачем — снимаем взвод, чтобы он не сработал на перерисовке после save.
    setAwaitingServerRates(false);
    // Собираем доп.валюты: только заполненные строки (code+rate). Пустые пропускаем.
    const displayCurrencies = rows
      .filter((r) => r.code.trim() && r.rate.trim())
      .map((r) => ({
        code: r.code.trim().toUpperCase(),
        symbol: r.symbol.trim(),
        rate: Number(r.rate),
        fractionDigits: r.fractionDigits.trim() ? Number(r.fractionDigits) : undefined,
        manualRate: r.manualRate,
      }));
    const result = await updateCurrencyUnitsAction({
      currency: {
        code: code.trim() || undefined,
        symbol: symbol.trim() || undefined,
        locale: locale.trim() || undefined,
        fractionDigits: fractionDigits.trim() ? Number(fractionDigits) : undefined,
      },
      exchange: { autoRate, displayCurrencies },
      units: { weight, dimension, system: 'metric' },
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.currencyUnitsForm.saveSuccess'));
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
          <label htmlFor="c-code" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.baseCurrencyCode')}</label>
          <input id="c-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={3} placeholder="RUB" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-500">{t('settings.currencyUnitsForm.baseCurrencyCodeHelp')}</p>
          {fe('currency.code') ? <p className="mt-1 text-xs text-red-600">{fe('currency.code')}</p> : null}
        </div>
        <div>
          <label htmlFor="c-symbol" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.symbol')}</label>
          <input id="c-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}
            placeholder="₽" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="c-locale" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.numberFormat')}</label>
          <input id="c-locale" value={locale} onChange={(e) => setLocale(e.target.value)}
            placeholder="ru-RU" className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-500">{t.rich('settings.currencyUnitsForm.numberFormatHelp', { code: (chunks) => <code>{chunks}</code> })}</p>
        </div>
        <div>
          <label htmlFor="c-frac" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.fractionDigitsLabel')}</label>
          <input id="c-frac" type="number" min={0} max={4} value={fractionDigits}
            onChange={(e) => setFractionDigits(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="u-weight" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.weightUnit')}</label>
          <select id="u-weight" value={weight} onChange={(e) => setWeight(e.target.value as typeof weight)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="g">{t('settings.currencyUnitsForm.weightGrams')}</option>
            <option value="kg">{t('settings.currencyUnitsForm.weightKilograms')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="u-dim" className="block text-sm font-medium text-gray-700">{t('settings.currencyUnitsForm.dimensionUnit')}</label>
          <select id="u-dim" value={dimension} onChange={(e) => setDimension(e.target.value as typeof dimension)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm">
            <option value="cm">{t('settings.currencyUnitsForm.dimCentimeters')}</option>
            <option value="mm">{t('settings.currencyUnitsForm.dimMillimeters')}</option>
          </select>
        </div>
      </div>

      {/* Мультивалюта: доп.валюты отображения по курсу. */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold text-gray-900">{t('settings.currencyUnitsForm.additionalCurrenciesTitle')}</h3>
        <p className="mt-1 text-xs text-gray-500">
          {t('settings.currencyUnitsForm.additionalCurrenciesHelp')}
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={autoRate} onChange={(e) => setAutoRate(e.target.checked)} />
          {t('settings.currencyUnitsForm.autoRateLabel')}
        </label>
        {exchange.rateUpdatedAt ? (
          <p className="mt-1 text-xs text-gray-500">
            {t('settings.currencyUnitsForm.rateUpdatedAt', { date: new Date(exchange.rateUpdatedAt).toLocaleString('ru-RU') })}
          </p>
        ) : null}

        <div className="mt-3 space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="rounded border border-gray-200 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                <input value={r.code} onChange={(e) => setRow(i, { code: e.target.value.toUpperCase() })}
                  maxLength={3} placeholder="USD" aria-label={t('settings.currencyUnitsForm.currencyCodeAria')}
                  className="rounded border border-gray-300 px-3 py-2 text-sm" />
                <input value={r.symbol} onChange={(e) => setRow(i, { symbol: e.target.value })}
                  placeholder="$" aria-label={t('settings.currencyUnitsForm.symbol')}
                  className="rounded border border-gray-300 px-3 py-2 text-sm" />
                <input type="number" min={0} step="0.0001" value={r.rate}
                  onChange={(e) => setRow(i, { rate: e.target.value })}
                  placeholder={t('settings.currencyUnitsForm.ratePlaceholder')} aria-label={t('settings.currencyUnitsForm.rateAria')}
                  className="rounded border border-gray-300 px-3 py-2 text-sm" />
                <input type="number" min={0} max={4} value={r.fractionDigits}
                  onChange={(e) => setRow(i, { fractionDigits: e.target.value })}
                  placeholder={t('settings.currencyUnitsForm.fractionPlaceholder')} aria-label={t('settings.currencyUnitsForm.fractionDigitsLabel')}
                  className="rounded border border-gray-300 px-3 py-2 text-sm" />
                <button type="button" onClick={() => removeRow(i)}
                  className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
                  {t('common.actions.delete')}
                </button>
              </div>
              {/* Пер-валютный ручной курс: признак у КАЖДОЙ валюты, а не один на раздел. */}
              <label className="mt-2 flex items-center gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={r.manualRate}
                  aria-label={t('settings.currencyUnitsForm.manualRateAria', { code: r.code || t('settings.currencyUnitsForm.manualRateAriaFallback') })}
                  onChange={(e) => setRow(i, { manualRate: e.target.checked })} />
                {t('settings.currencyUnitsForm.manualRateLabel')}
              </label>
              {r.rateUpdatedAt ? (
                <p className="mt-1 text-xs text-gray-500">
                  {t('settings.currencyUnitsForm.rateUpdatedAt', { date: new Date(r.rateUpdatedAt).toLocaleString('ru-RU') })}
                </p>
              ) : null}
            </div>
          ))}
        </div>
        {fe('exchange.displayCurrencies') ? (
          <p className="mt-1 text-xs text-red-600">{fe('exchange.displayCurrencies')}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select value={effectiveAddCode} onChange={(e) => setAddCode(e.target.value)}
            aria-label={t('settings.currencyUnitsForm.addCurrencyAria')}
            className="rounded border border-gray-300 px-3 py-2 text-sm">
            {addable.map((c) => (
              <option key={c.code} value={c.code}>{t('settings.currencyUnitsForm.addOption', { code: c.code, label: c.label })}</option>
            ))}
          </select>
          <button type="button" onClick={addRow} disabled={addable.length === 0}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {t('settings.currencyUnitsForm.addCurrencyButton')}
          </button>
          <button type="button" onClick={refreshRates} disabled={pending}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {t('settings.currencyUnitsForm.refreshRatesButton')}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {t('settings.currencyUnitsForm.refreshRatesHelp')}
        </p>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('common.actions.save')}
        </button>
      </div>
    </div>
  );
}
