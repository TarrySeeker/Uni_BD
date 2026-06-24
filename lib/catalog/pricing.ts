/**
 * Чистые функции ценообразования каталога (docs/06 §3.1–§3.2, ADR-009).
 *
 * «Скидка» и «новизна» НЕ хранятся в БД — они производные:
 *  - скидка % и факт «со скидкой» вычисляются из price/compare_at_price;
 *  - «новизна» — троичная логика: явный is_new (true/false) или вычисление по
 *    created_at и порогу SHOP_NEW_PRODUCT_DAYS, если is_new == null.
 *
 * Деньги в домене — строки (NUMERIC(14,2), точность не теряется). Эти функции
 * принимают и string, и number — парсинг в число делается единообразно внутри.
 * Тестируемы без БД и без Next.
 */

/** Денежное значение: строка NUMERIC или число; null/undefined → «нет цены». */
export type Money = string | number | null | undefined;

/** Парсит денежное значение в конечное число или null (нечисловое/пустое → null). */
function toNumber(v: Money): number | null {
  if (v === null || v === undefined) {
    return null;
  }
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Процент скидки относительно «цены было» (compareAt).
 * Возвращает целое число процентов (округление к ближайшему), если есть
 * корректная скидка (compareAt > price > 0... вернее compareAt > price и
 * compareAt > 0); иначе — null (нет скидки/некорректные данные).
 *
 * discount_pct = round((compareAt − price) / compareAt * 100)  (docs/06 §3.1).
 */
export function discountPercent(price: Money, compareAt: Money): number | null {
  const p = toNumber(price);
  const c = toNumber(compareAt);
  if (p === null || c === null) {
    return null;
  }
  if (c <= 0 || c <= p) {
    return null;
  }
  return Math.round(((c - p) / c) * 100);
}

/**
 * Предикат «со скидкой»: compareAt задан и строго больше эффективной цены
 * (docs/06 §3.1). При compareAt <= price бейдж не показывается.
 */
export function isOnSale(price: Money, compareAt: Money): boolean {
  const p = toNumber(price);
  const c = toNumber(compareAt);
  if (p === null || c === null) {
    return false;
  }
  return c > p;
}

/**
 * Эффективная «цена было» варианта: своя, иначе наследуется от товара
 * (docs/06 §3.1: COALESCE(variant.compare_at_price, product.compare_at_price)).
 */
export function effectiveCompareAt(
  variantCompareAt: Money,
  productCompareAt: Money,
): number | null {
  const v = toNumber(variantCompareAt);
  return v !== null ? v : toNumber(productCompareAt);
}

/**
 * Троичная «новизна» (docs/06 §3.2):
 *  - isNew !== null → явный override редактора (true/false) — возвращается как есть;
 *  - isNew === null → вычисление: товар «новый», если createdAt в пределах
 *    newDays дней от now (createdAt >= now − newDays·24ч).
 *
 * now передаётся параметром для детерминизма в тестах (по умолчанию — текущее время).
 */
export function resolveIsNew(
  isNew: boolean | null,
  createdAt: Date,
  newDays: number,
  now: Date = new Date(),
): boolean {
  if (isNew !== null) {
    return isNew;
  }
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return false;
  }
  const days = Number.isFinite(newDays) ? Math.max(0, newDays) : 0;
  const thresholdMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return createdAt.getTime() >= thresholdMs;
}
