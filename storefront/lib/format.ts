/**
 * Форматирование цены под витрину carre. Цена товара приходит строкой NUMERIC в
 * рублях (напр. "7500.00"); показываем как «7 500 ₽» (как priceCurFull в оригинале).
 *
 * Мультивалюта (₽/€): базовая валюта — рубли (цена хранится/оплачивается в ₽).
 * Доп.валюты — ТОЛЬКО отображение по курсу: цена_€ = цена_₽ / rate, где rate =
 * рублей за 1 единицу валюты (EUR rate=100 → 1€=100₽). Реальные деньги всегда в ₽.
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

/**
 * Валюта ОТОБРАЖЕНИЯ для переключателя (₽/€). rate = единиц базовой (₽) за 1
 * единицу этой валюты; fractionDigits — знаков после запятой при показе. Базовая
 * валюта (₽) представляется как { code:'RUB', rate:1, fractionDigits:0 }.
 */
export interface DisplayCurrency {
  code: string;
  symbol: string;
  /** Единиц базовой валюты за 1 единицу этой (для базовой = 1). */
  rate: number;
  fractionDigits: number;
}

/**
 * Форматирует РУБЛЁВУЮ цену для показа в выбранной валюте отображения.
 *  - базовая (₽, rate=1): округляем до целого (fractionDigits 0), «7 500 ₽»;
 *  - доп.валюта (€): делим на rate и показываем с fractionDigits знаками, «75,00 €».
 * Пустое/некорректное значение → пустая строка (как раньше). Отрицательный/нулевой
 * rate защищён (не делим на 0): трактуем как базовую (rate=1).
 */
export function formatDisplayPrice(
  priceRub: string | number | null | undefined,
  display: DisplayCurrency,
): string {
  if (priceRub == null) return '';
  const n = typeof priceRub === 'number' ? priceRub : Number(priceRub);
  if (!Number.isFinite(n)) return '';
  const rateValid = Number.isFinite(display.rate) && display.rate > 0;
  const rate = rateValid ? display.rate : 1;
  const converted = n / rate;
  // При защите от некорректного курса (rate<=0) деградируем к базовому показу:
  // целое число (0 знаков), но с символом выбранной валюты.
  const digits = rateValid && Number.isInteger(display.fractionDigits) ? display.fractionDigits : 0;
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(digits === 0 ? Math.round(converted) : converted);
  return `${formatted} ${display.symbol}`.trim();
}

/**
 * Легаси-форматтер (рубли по умолчанию). Оставлен для обратной совместимости:
 * серверные компоненты, которым не нужна мультивалюта, зовут formatPrice(price)
 * и получают рублёвый показ как раньше (fractionDigits 0). Символ/код опциональны.
 */
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
