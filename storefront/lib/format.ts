/**
 * Форматирование цены под витрину carre. Цена товара приходит строкой NUMERIC в
 * рублях (напр. "7500.00"); показываем как «7 500 ₽» (как priceCurFull в оригинале).
 */

const SYMBOLS: Record<string, string> = {
  RUB: '₽', // ₽
  EUR: '€', // €
  USD: '$',
};

export function currencySymbol(code: string | undefined, explicit?: string | null): string {
  if (explicit) return explicit;
  if (code && SYMBOLS[code]) return SYMBOLS[code];
  return code ?? '';
}

export function formatPrice(
  price: string | number | null | undefined,
  currencyCode = 'RUB',
  symbol?: string | null,
): string {
  if (price == null) return '';
  const n = typeof price === 'number' ? price : Number(price);
  if (!Number.isFinite(n)) return '';
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(
    Math.round(n),
  );
  return `${formatted} ${currencySymbol(currencyCode, symbol)}`.trim();
}
