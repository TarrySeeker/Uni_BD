/**
 * Сопоставление ПОЛНОЙ корзины покупателя с ответом сервера /cart/quote
 * (аудит minor №1 и №2). Чистый модуль — без React/DOM, поэтому проверяем
 * поведением, а не чтением исходника.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Серверу уходит УРЕЗАННЫЙ список позиций: элементы без productId
 * (старые записи localStorage) оформить нельзя, и чекаут их отфильтровывает. Сервер
 * же нумерует и `issues[].index`, и порядок `lines[]` ПО ЭТОМУ УРЕЗАННОМУ списку, а
 * рендер идёт по ПОЛНОЙ корзине. Любое прямое использование серверного индекса в
 * рендере промахивается мимо строки — ровно этот дефект и чинился:
 *   • №1 — метка «нет в наличии» показывалась не у той позиции;
 *   • №2 — суммы строк брались из localStorage, тогда как итог считал сервер.
 *
 * Здесь три чистые операции: построение карты индексов, раскладка issues и
 * раскладка серверных строк по индексам ПОЛНОЙ корзины.
 */

/** Минимум, который нужен от позиции корзины для сопоставления. */
export interface CartLineLike {
  /** UUID товара; отсутствует у старых записей localStorage — такие серверу не уходят. */
  productId?: string;
  /** Цена за штуку из корзины (рубли) — для сверки с серверной. */
  price: number;
}

/** Серверная строка расчёта (подмножество QuoteLineDto). */
export interface QuoteLineLike {
  unitPrice: string;
  lineTotal: string;
}

/**
 * Индекс УРЕЗАННОГО (уехавшего серверу) массива → индекс ПОЛНОЙ корзины.
 * Строится тем же критерием, что и сам урезанный массив: позиция едет серверу
 * тогда и только тогда, когда у неё есть productId.
 */
export function buildApiIndexToCartIndex(
  items: readonly CartLineLike[],
): Map<number, number> {
  const map = new Map<number, number>();
  let apiIndex = 0;
  items.forEach((it, cartIndex) => {
    if (!it.productId) return;
    map.set(apiIndex, cartIndex);
    apiIndex += 1;
  });
  return map;
}

/**
 * Проблемы позиций (issues) → карта «индекс ПОЛНОЙ корзины → код проблемы».
 *
 * Индекс, которому не нашлось строки (сервер отстал от корзины — покупатель успел
 * удалить позицию), ОТБРАСЫВАЕТСЯ: повесить чужую проблему на чужую строку хуже,
 * чем не показать её вовсе.
 */
export function mapIssuesToCartIndex(
  issues: readonly { index: number; code: string }[],
  apiIndexToCartIndex: ReadonlyMap<number, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const iss of issues) {
    const cartIndex = apiIndexToCartIndex.get(iss.index);
    if (cartIndex !== undefined) out.set(cartIndex, iss.code);
  }
  return out;
}

/**
 * Серверные строки расчёта → карта «индекс ПОЛНОЙ корзины → строка».
 *
 * 🔴 ТОНКОСТЬ, из-за которой нельзя просто взять lines[i]: `lines` содержит ТОЛЬКО
 * успешно разрешённые позиции — та, по которой пришёл issue, в lines НЕ попадает
 * (см. lib/orders/repository: `continue` до `lines.push`). Поэтому индекс в lines
 * сдвинут относительно индекса в отправленном массиве ровно на число проблемных
 * позиций перед ним. Восстанавливаем соответствие тем же проходом, что делал сервер.
 */
export function mapServerLinesToCartIndex(
  lines: readonly QuoteLineLike[],
  issues: readonly { index: number }[],
  apiItemsCount: number,
  apiIndexToCartIndex: ReadonlyMap<number, number>,
): Map<number, QuoteLineLike> {
  const out = new Map<number, QuoteLineLike>();
  const failed = new Set(issues.map((iss) => iss.index));
  let lineIdx = 0;
  for (let apiIndex = 0; apiIndex < apiItemsCount; apiIndex++) {
    if (failed.has(apiIndex)) continue;
    const line = lines[lineIdx];
    lineIdx += 1;
    if (!line) continue;
    const cartIndex = apiIndexToCartIndex.get(apiIndex);
    if (cartIndex !== undefined) out.set(cartIndex, line);
  }
  return out;
}

/**
 * Разошлась ли цена ХОТЯ БЫ ОДНОЙ позиции с той, что лежит в корзине (№2).
 * Сверяем ПО КОПЕЙКАМ: '7500' и 7500.00 — одна сумма, строковое сравнение дало бы
 * ложное расхождение. Найдено → покупателю показывается объяснение, почему суммы
 * строк не те, что он запомнил в корзине.
 */
export function hasPriceChanged(
  items: readonly CartLineLike[],
  serverLines: ReadonlyMap<number, QuoteLineLike>,
): boolean {
  return items.some((it, idx) => {
    const line = serverLines.get(idx);
    if (!line) return false;
    const server = Math.round(Number(line.unitPrice) * 100);
    const cart = Math.round(Number(it.price) * 100);
    // Нечисловая цена (битая запись корзины) — не повод кричать о смене цены.
    if (!Number.isFinite(server) || !Number.isFinite(cart)) return false;
    return server !== cart;
  });
}
