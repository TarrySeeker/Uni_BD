'use client';

/**
 * Клиентский стор ВЫБОРА валюты отображения витрины (мультивалюта ₽/€).
 *
 * Базовая валюта — рубли (цены хранятся/оплачиваются в ₽). Выбор доп.валюты
 * влияет ТОЛЬКО на показ: цена_€ = цена_₽ / rate. Выбор хранится в localStorage
 * (как корзина/избранное) и синхронизируется между вкладками (`storage`) и внутри
 * вкладки (кастомное событие) — калька lib/cart.ts / lib/favorites.ts.
 *
 * Список доступных валют приходит из настроек магазина (PublicSettingsDto.currency)
 * через <CurrencyProvider>. SSR всегда рендерит БАЗОВУЮ (₽) — до маунта выбор из
 * localStorage неизвестен; после маунта клиент переключается на сохранённый выбор.
 * Это исключает гидрационные ошибки (server и первый client render совпадают) —
 * тот же приём `mounted`, что в корзине.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PublicSettingsDto } from '@/lib/types';
import type { DisplayCurrency } from '@/lib/format';

const KEY = 'sf_currency_v1';
const EVENT = 'sf-currency-changed';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** Базовая валюта витрины (₽) из настроек магазина. rate=1 (сама с собой). */
function baseCurrency(settings: PublicSettingsDto | null): DisplayCurrency {
  const code = settings?.currency.code ?? 'RUB';
  const symbol = settings?.currency.symbol ?? (code === 'RUB' ? '₽' : code);
  // Базовая — рубли: показываем целыми (0 знаков), как исторический рублёвый формат.
  return { code, symbol, rate: 1, fractionDigits: 0 };
}

/** Все валюты для переключателя: базовая + доп.валюты отображения из настроек. */
export function availableCurrencies(settings: PublicSettingsDto | null): DisplayCurrency[] {
  const base = baseCurrency(settings);
  const display = (settings?.currency.displayCurrencies ?? []).map((d) => ({
    code: d.code,
    symbol: d.symbol,
    rate: d.rate,
    fractionDigits: d.fractionDigits,
  }));
  // Базовая всегда первая; дубли по коду отбрасываем (базовая приоритетна).
  const seen = new Set([base.code]);
  const rest = display.filter((d) => !seen.has(d.code) && (seen.add(d.code), true));
  return [base, ...rest];
}

function readSelectedCode(): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeSelectedCode(code: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, code);
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* localStorage недоступен (приватный режим) — молча игнорируем */
  }
}

interface CurrencyContextValue {
  /** Доступные валюты (базовая + доп.валюты из настроек). */
  currencies: DisplayCurrency[];
  /** Текущая выбранная валюта (до маунта — всегда базовая, анти-гидрация). */
  selected: DisplayCurrency;
  /** Смена валюты (persist в localStorage + broadcast). */
  setCurrency: (code: string) => void;
  /** true после маунта: можно доверять localStorage-выбору. */
  mounted: boolean;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({
  settings,
  children,
}: {
  settings: PublicSettingsDto | null;
  children: ReactNode;
}) {
  const currencies = useMemo(() => availableCurrencies(settings), [settings]);
  const base = currencies[0];

  const [selectedCode, setSelectedCode] = useState<string>(base.code);
  const [mounted, setMounted] = useState(false);

  // После маунта читаем сохранённый выбор (если валюта ещё доступна в настройках).
  useEffect(() => {
    setMounted(true);
    const stored = readSelectedCode();
    if (stored && currencies.some((c) => c.code === stored)) {
      setSelectedCode(stored);
    }
    // Синхронизация между вкладками + внутри вкладки.
    const onChange = () => {
      const code = readSelectedCode();
      if (code && currencies.some((c) => c.code === code)) setSelectedCode(code);
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [currencies]);

  const setCurrency = useCallback(
    (code: string) => {
      if (!currencies.some((c) => c.code === code)) return;
      writeSelectedCode(code);
      setSelectedCode(code);
    },
    [currencies],
  );

  // До маунта — базовая (SSR-совместимо). После — выбранная.
  const selected =
    (mounted && currencies.find((c) => c.code === selectedCode)) || base;

  const value = useMemo<CurrencyContextValue>(
    () => ({ currencies, selected, setCurrency, mounted }),
    [currencies, selected, setCurrency, mounted],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

/**
 * Хук доступа к выбранной валюте. Вне провайдера (например изолированный рендер)
 * безопасно откатывается на базовые рубли — витрина не падает.
 */
export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (ctx) return ctx;
  const fallback: DisplayCurrency = { code: 'RUB', symbol: '₽', rate: 1, fractionDigits: 0 };
  return {
    currencies: [fallback],
    selected: fallback,
    setCurrency: () => {},
    mounted: false,
  };
}
