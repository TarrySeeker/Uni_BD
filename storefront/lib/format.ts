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

/**
 * 🔴 Аудит minor №9 — ЛОКАЛЬ ФОРМАТА ЧИСЕЛ приходит из НАСТРОЕК МАГАЗИНА
 * (`shop_settings.currency.locale`, публичное поле PublicSettingsDto.currency.locale),
 * а не зашита в код. Раньше здесь стояло `Intl.NumberFormat('ru-RU', …)`, из-за чего
 * магазин на любом другом рынке получал русскую группировку разрядов («7 500» вместо
 * «7,500») независимо от своих настроек — прямое нарушение мультитенантности.
 *
 * Дефолт сохраняем прежним ('ru-RU'), чтобы магазин, у которого поле не заполнено,
 * не изменил вид цен после выката (анти-регресс).
 */
export const DEFAULT_NUMBER_LOCALE = 'ru-RU';

/**
 * Строит Intl.NumberFormat, ПЕРЕЖИВАЯ мусор в настройках. `currency.locale` — это
 * свободная строка из админки; невалидный BCP-47 тег («ru_RU», «не-локаль») роняет
 * конструктор RangeError'ом, и вся страница с ценами упала бы белым экраном.
 * Поэтому на ошибке молча деградируем к дефолтной локали.
 */
function numberFormat(
  locale: string | null | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const tag = typeof locale === 'string' && locale.trim() !== '' ? locale.trim() : undefined;
  if (tag !== undefined) {
    try {
      return new Intl.NumberFormat(tag, options);
    } catch {
      /* невалидный тег из настроек — падаем на дефолт ниже */
    }
  }
  return new Intl.NumberFormat(DEFAULT_NUMBER_LOCALE, options);
}

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
  /**
   * 🔴 №9 — локаль ФОРМАТА ЧИСЕЛ магазина (BCP-47, напр. 'ru-RU'/'en-US'/'de-DE') из
   * настроек. Управляет группировкой разрядов и десятичным разделителем. Опционально:
   * старые вызовы/настройки без поля получают DEFAULT_NUMBER_LOCALE — прежний вид.
   */
  locale?: string | null;
}

/**
 * Карта РУЧНЫХ цен показа товара: `{"EUR":"480.00"}` (products.display_prices).
 * Приходит в DTO товара. Пусто/не задано → цена считается по курсу.
 */
export type DisplayPrices = Record<string, string>;

/**
 * Достаёт ручную цену для выбранной валюты.
 *
 * Правила (совпадают с серверной валидацией displayPricesSchema — витрина не
 * доверяет данным вслепую, но и не падает от мусора):
 *  - код валюты сравнивается БЕЗ учёта регистра;
 *  - значение должно быть СТРОГО ПОЛОЖИТЕЛЬНЫМ конечным числом; пусто/мусор/
 *    ноль/минус → оверрайда нет, считаем по курсу;
 *  - к БАЗОВОЙ валюте (rate === 1) оверрайд НЕ применяется: это валюта денег,
 *    и подмена ценника разошлась бы с суммой заказа и списанием.
 */
function lookupOverride(
  display: DisplayCurrency,
  prices: DisplayPrices | null | undefined,
): number | null {
  if (!prices || typeof prices !== 'object') return null;
  // Базовая валюта — деньги, а не «отображение»: оверрайд к ней не применяем.
  if (!(Number.isFinite(display.rate) && display.rate > 0) || display.rate === 1) return null;
  const wanted = String(display.code ?? '').trim().toUpperCase();
  if (wanted === '') return null;
  for (const [code, raw] of Object.entries(prices)) {
    if (String(code).trim().toUpperCase() !== wanted) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
  }
  return null;
}

/**
 * Форматирует РУБЛЁВУЮ цену для показа в выбранной валюте отображения.
 *  - базовая (₽, rate=1): округляем до целого (fractionDigits 0), «7 500 ₽»;
 *  - доп.валюта (€): делим на rate и показываем с fractionDigits знаками, «75,00 €».
 * Пустое/некорректное значение → пустая строка (как раньше). Отрицательный/нулевой
 * rate защищён (не делим на 0): трактуем как базовую (rate=1).
 *
 * 🔴 ЭТАП 3 — РУЧНАЯ «КРУГЛАЯ» ЦЕНА. Третий (необязательный) аргумент — карта
 * ручных цен товара. Если для ВЫБРАННОЙ доп.валюты в ней есть корректная сумма,
 * показываем РОВНО ЕЁ вместо деления на курс: премиальному бренду нужен ценник
 * «480 €», а не «4783,12 €», и он не должен «плыть» вслед за курсом ЦБ.
 *
 * Это ТОЛЬКО показ ценника: сумма к оплате всегда считается от рублёвой цены
 * (см. итог корзины и чекаут — туда карта не передаётся вовсе). Аргумент
 * необязателен, поэтому все прежние вызовы сохраняют прежнее поведение.
 */
export function formatDisplayPrice(
  priceRub: string | number | null | undefined,
  display: DisplayCurrency,
  displayPrices?: DisplayPrices | null,
): string {
  if (priceRub == null) return '';
  const n = typeof priceRub === 'number' ? priceRub : Number(priceRub);
  if (!Number.isFinite(n)) return '';
  const rateValid = Number.isFinite(display.rate) && display.rate > 0;
  const rate = rateValid ? display.rate : 1;
  const override = lookupOverride(display, displayPrices);
  const converted = override ?? n / rate;
  // При защите от некорректного курса (rate<=0) деградируем к базовому показу:
  // целое число (0 знаков), но с символом выбранной валюты.
  const digits = rateValid && Number.isInteger(display.fractionDigits) ? display.fractionDigits : 0;
  const formatted = numberFormat(display.locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(digits === 0 ? Math.round(converted) : converted);
  return `${formatted} ${display.symbol}`.trim();
}

/**
 * Формат чисел магазина для legacy-форматтера (№9). Оба поля опциональны: без них
 * поведение ровно прежнее (ru-RU, 0 знаков) — анти-регресс для вызовов, которые
 * настроек не видят.
 */
export interface NumberFormatOpts {
  /** BCP-47 локаль формата из настроек (`currency.locale`). */
  locale?: string | null;
  /** Знаков после запятой из настроек (`currency.fractionDigits`). */
  fractionDigits?: number | null;
}

/**
 * Легаси-форматтер (рубли по умолчанию). Оставлен для обратной совместимости:
 * серверные компоненты, которым не нужна мультивалюта, зовут formatPrice(price)
 * и получают прежний показ. Символ/код опциональны.
 *
 * 🔴 №9: четвёртым аргументом принимает ФОРМАТ МАГАЗИНА (локаль + знаки после
 * запятой). Не передан → DEFAULT_NUMBER_LOCALE и 0 знаков, как было.
 */
export function formatPrice(
  price: string | number | null | undefined,
  currencyCode = 'RUB',
  symbol?: string | null,
  opts?: NumberFormatOpts,
): string {
  if (price == null) return '';
  const n = typeof price === 'number' ? price : Number(price);
  if (!Number.isFinite(n)) return '';
  // Знаки после запятой: из настроек, если это целое в разумных пределах (схема
  // ограничивает 0..4); иначе — исторический 0.
  const raw = opts?.fractionDigits;
  const digits =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 4 ? raw : 0;
  const formatted = numberFormat(opts?.locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(digits === 0 ? Math.round(n) : n);
  return `${formatted} ${currencySymbol(currencyCode, symbol)}`.trim();
}
