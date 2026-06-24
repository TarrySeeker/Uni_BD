/**
 * Форматирование цен/скидок для UI админки каталога (docs/06 §3.5).
 *
 * Чистые функции без обращения к БД/Next — тестируемы юнитом. Валюта НЕ
 * хардкодится: символ берётся из карты по коду `SHOP_CURRENCY` (env), с
 * безопасным фолбэком на сам код, если валюта незнакома. Деньги в домене —
 * строки (NUMERIC(14,2)); парсинг в число делается единообразно внутри.
 */

import type { Money } from '@/lib/catalog/pricing';

/** Символы распространённых валют (расширяемо; незнакомый код → сам код). */
const CURRENCY_SYMBOL: Record<string, string> = {
  RUB: '₽',
  USD: '$',
  EUR: '€',
  KZT: '₸',
  BYN: 'Br',
  UAH: '₴',
};

/** Возвращает символ валюты по коду (RUB → ₽); незнакомый код → сам код. */
export function currencySymbol(code: string): string {
  const key = code.trim().toUpperCase();
  return CURRENCY_SYMBOL[key] ?? key;
}

/** Парсит денежное значение в конечное число или null (нечисловое/пустое → null). */
function toNumber(v: Money): number | null {
  if (v === null || v === undefined) {
    return null;
  }
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Форматирует число с разделителем разрядов (узкий неразрывный пробел) и без
 * дробной части, если она нулевая (199.00 → «199», 199.90 → «199,90»).
 * Локаль ru-RU: десятичный разделитель — запятая.
 */
function formatAmount(n: number): string {
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Форматирует цену с символом валюты: `formatPrice('1999.90', 'RUB')` → «1 999,90 ₽».
 * Невалидное значение → «—» (нет цены).
 */
export function formatPrice(value: Money, currency = 'RUB'): string {
  const n = toNumber(value);
  if (n === null) {
    return '—';
  }
  return `${formatAmount(n)} ${currencySymbol(currency)}`;
}

/**
 * Форматирует процент скидки для бейджа: `formatDiscount(21)` → «−21 %».
 * null/0/отрицательное → null (бейдж не показывается).
 * Использует настоящий минус (U+2212) и неразрывный пробел перед знаком %.
 */
export function formatDiscount(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct <= 0) {
    return null;
  }
  return `−${Math.round(pct)} %`;
}
