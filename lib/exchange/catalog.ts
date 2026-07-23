/**
 * Справочник валют ПЛАТФОРМЫ для выбора доп.валюты отображения в админке.
 *
 * Это не список валют конкретного магазина (тот живёт в настройке exchange), а
 * общий словарь ISO 4217 → символ/знаки после запятой, чтобы форма не подставляла
 * очередной хардкод («+ Добавить валюту» жёстко создавала строку EUR). Магазин
 * любой ниши и любой страны выбирает нужную из списка; код в форме остаётся
 * редактируемым, поэтому валюта вне словаря тоже вводится руками.
 *
 * Курс здесь НЕ хранится: его тянет крон ЦБ РФ либо задаёт владелец вручную.
 */

export interface CurrencyCatalogEntry {
  /** ISO 4217, 3 заглавные латинские буквы. */
  code: string;
  /** Символ для показа цены. */
  symbol: string;
  /** Знаков после запятой при показе. */
  fractionDigits: number;
  /** Название для выпадающего списка. */
  label: string;
}

/**
 * Валюты, которые отдаёт источник курсов ЦБ РФ (cbr-xml-daily) — то есть те, для
 * которых работает автообновление. Порядок = порядок в выпадающем списке.
 */
export const CURRENCY_CATALOG: readonly CurrencyCatalogEntry[] = [
  { code: 'USD', symbol: '$', fractionDigits: 2, label: 'Доллар США' },
  { code: 'EUR', symbol: '€', fractionDigits: 2, label: 'Евро' },
  { code: 'GBP', symbol: '£', fractionDigits: 2, label: 'Фунт стерлингов' },
  { code: 'CNY', symbol: '¥', fractionDigits: 2, label: 'Китайский юань' },
  { code: 'JPY', symbol: '¥', fractionDigits: 0, label: 'Японская иена' },
  { code: 'CHF', symbol: '₣', fractionDigits: 2, label: 'Швейцарский франк' },
  { code: 'TRY', symbol: '₺', fractionDigits: 2, label: 'Турецкая лира' },
  { code: 'AED', symbol: 'د.إ', fractionDigits: 2, label: 'Дирхам ОАЭ' },
  { code: 'KZT', symbol: '₸', fractionDigits: 2, label: 'Казахстанский тенге' },
  { code: 'BYN', symbol: 'Br', fractionDigits: 2, label: 'Белорусский рубль' },
  { code: 'AMD', symbol: '֏', fractionDigits: 2, label: 'Армянский драм' },
  { code: 'RSD', symbol: 'дин.', fractionDigits: 2, label: 'Сербский динар' },
  { code: 'INR', symbol: '₹', fractionDigits: 2, label: 'Индийская рупия' },
  { code: 'RUB', symbol: '₽', fractionDigits: 0, label: 'Российский рубль' },
] as const;

/** Запись справочника по ISO-коду (регистронезависимо). null — валюты нет. */
export function lookupCurrency(code: string): CurrencyCatalogEntry | null {
  const norm = code.trim().toUpperCase();
  return CURRENCY_CATALOG.find((c) => c.code === norm) ?? null;
}

/**
 * Валюты, доступные к добавлению: словарь минус уже добавленные и минус базовая
 * валюта магазина (её показывает витрина сама, дубль в списке бессмысленен).
 */
export function availableToAdd(
  baseCode: string | null | undefined,
  alreadyUsed: readonly string[],
): CurrencyCatalogEntry[] {
  const taken = new Set(
    [baseCode ?? '', ...alreadyUsed].map((c) => c.trim().toUpperCase()).filter(Boolean),
  );
  return CURRENCY_CATALOG.filter((c) => !taken.has(c.code));
}
