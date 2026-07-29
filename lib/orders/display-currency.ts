/**
 * СНИМОК ВАЛЮТЫ ОТОБРАЖЕНИЯ в заказе (миграция 0059) — «что покупатель видел».
 *
 * КОНТЕКСТ (денежный риск). Витрина умеет показывать цены в ДОПОЛНИТЕЛЬНОЙ валюте
 * (переключатель ₽/€ в шапке, курс ЦБ РФ обновляется кроном), а эквайринг у
 * магазина РУБЛЁВЫЙ: адаптеры lib/payments берут сумму исключительно из
 * `order.grandTotal` в БАЗОВОЙ валюте и о курсе не знают вовсе (это защищено
 * guard-тестом tests/exchange/payment-base-currency.test.ts). Значит покупатель,
 * ходивший по каталогу в евро, платит рублями — и на чекауте ему об этом теперь
 * прямо говорит дисклеймер (ЭТАП 1).
 *
 * ПРОБЛЕМА, которую решает снимок. Курс живой: сегодня 88,76 ₽/€, через неделю
 * другой. Претензия «мне показывали 480 €, а списали больше» разбирается только
 * если зафиксировано, ЧТО ИМЕННО было на экране в момент оформления. Ни один из
 * существующих столбцов этого не хранит: `orders.currency` — БАЗОВАЯ валюта
 * заказа (в ней и суммы), настройки `exchange` перезаписываются кроном.
 *
 * ГРАНИЦЫ (важно не перепутать):
 *   • Поля СПРАВОЧНЫЕ. `grand_total`, платёжный путь, сверка с эквайером и
 *     возвраты от них не зависят ни в одной точке. Это запись в журнал, а не
 *     деньги.
 *   • ADR-010 (anti-tamper): от клиента принимается ТОЛЬКО КОД выбранной валюты
 *     отображения. Курс сервер читает из настроек магазина, а итог считает САМ от
 *     собственного рублёвого `grandTotal`. Присланное клиентом число к деньгам не
 *     допускается ни в каком виде — иначе подделка тела запроса рисовала бы в
 *     карточке заказа любой «курс», по которому потом требуют перерасчёт.
 *   • Мультитенантность: базовая валюта (или магазин без доп.валют) → снимка НЕТ
 *     (null). Одновалютный магазин платформы не увидит никаких изменений.
 *
 * ЕДИНИЦЫ (ловушка проекта: суммы заказа — рубли numeric(14,2), платёжный слой —
 * копейки). Здесь ДЕНЬГИ: `displayTotal` — строка с двумя знаками в валюте
 * ОТОБРАЖЕНИЯ (евро), НЕ копейки. `displayRate` — единиц базовой валюты за 1
 * единицу валюты отображения (EUR rate=88.7602 → 1 € = 88,7602 ₽), строка с 8
 * знаками под numeric(18,8).
 *
 * ОКРУГЛЕНИЕ. Итог в евро считается ОТ РУБЛЁВОГО ИТОГА (grandTotal / rate), а НЕ
 * суммированием округлённых позиций: второй способ расходится с итогом на единицы
 * валюты и порождает ровно ту претензию, ради которой снимок и делается.
 */

/** Валюта отображения из настроек магазина (структурная типизация). */
interface DisplayCurrencyLike {
  code?: unknown;
  rate?: unknown;
}

/** Часть эффективных настроек, из которой берётся курс (структурная типизация). */
export interface DisplaySnapshotSettings {
  currency?: { code?: unknown };
  exchange?: { displayCurrencies?: DisplayCurrencyLike[] } | null;
}

/** Снимок для колонок orders.display_* (все три пишутся вместе либо не пишутся вовсе). */
export interface DisplaySnapshot {
  /** ISO-4217 валюты ОТОБРАЖЕНИЯ (orders.display_currency). */
  displayCurrency: string;
  /** Курс: единиц базовой за 1 единицу отображаемой, строка numeric(18,8). */
  displayRate: string;
  /** Итог в валюте отображения, строка numeric(14,2) — ДЕНЬГИ, не копейки. */
  displayTotal: string;
}

/** Аргументы резолва. Курса/суммы в валюте отображения на входе НЕТ — это принцип. */
export interface ResolveDisplaySnapshotArgs {
  /** Код валюты отображения, выбранный покупателем (единственное, что шлёт клиент). */
  requestedCurrency: string | null | undefined;
  /** СЕРВЕРНЫЙ итог заказа в базовой валюте, строка numeric(14,2). */
  grandTotal: string;
  /** Эффективные настройки магазина (БД ⊕ env). */
  settings: DisplaySnapshotSettings | null | undefined;
}

/** Код валюты в каноне ISO-4217 или undefined (пусто/не строка → «значения нет»). */
function canonicalCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.toUpperCase();
}

/** Положительный конечный курс или undefined (0/отрицательный/NaN/∞ → нет курса). */
function positiveRate(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Строит снимок валюты отображения для НОВОГО заказа либо null, если снимку не
 * место: покупатель смотрел в базовой валюте, валюта не прислана, код неизвестен
 * настройкам, курс невалиден, итог нечитаем.
 *
 * НИКОГДА НЕ БРОСАЕТ. Это справочное поле: любая аномалия обязана деградировать к
 * «снимка нет», а не отменить оплаченный покупателем заказ.
 */
export function resolveDisplaySnapshot(
  args: ResolveDisplaySnapshotArgs,
): DisplaySnapshot | null {
  const requested = canonicalCode(args.requestedCurrency);
  if (!requested) return null;

  // Базовая валюта магазина — снимок не нужен (заказ и так в ней).
  const base = canonicalCode(args.settings?.currency?.code);
  if (base && requested === base) return null;

  const list = args.settings?.exchange?.displayCurrencies;
  if (!Array.isArray(list)) return null;

  const found = list.find((c) => canonicalCode(c?.code) === requested);
  if (!found) return null;

  const rate = positiveRate(found.rate);
  if (rate === undefined) return null;

  // Рублёвый итог: строка NUMERIC(14,2) из расчёта заказа. Нечитаемое значение —
  // повод отказаться от снимка, но не повод сорвать заказ.
  //
  // Пустая строка отсекается ОТДЕЛЬНО: Number('') === 0, и без этой проверки
  // отсутствующий итог тихо превратился бы в снимок «клиент видел 0,00 €» —
  // выдуманный факт в карточке заказа хуже отсутствующего.
  if (typeof args.grandTotal !== 'string' || args.grandTotal.trim() === '') return null;
  const totalBase = Number(args.grandTotal);
  if (!Number.isFinite(totalBase) || totalBase < 0) return null;

  // ОТ ИТОГА, а не по позициям (см. шапку). Half-up к сотой доле валюты.
  const converted = Math.round((totalBase / rate) * 100) / 100;
  if (!Number.isFinite(converted)) return null;

  return {
    displayCurrency: requested,
    // 8 знаков — под numeric(18,8): курс ЦБ имеет 4, ручные/крупнономинальные
    // валюты могут иметь больше; хвост нулями безопасен для сравнения строк.
    displayRate: rate.toFixed(8),
    displayTotal: converted.toFixed(2),
  };
}
