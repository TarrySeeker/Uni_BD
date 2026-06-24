/**
 * Чистые функции серверного расчёта корзины (docs/07 §3.1–§3.3, ADR-010 anti-tamper).
 *
 * ИТОГ СЧИТАЕТ СЕРВЕР. Эти функции принимают УЖЕ нормализованные позиции с
 * ценами, ВЗЯТЫМИ ИЗ КАТАЛОГА вызывающим кодом (repository.quoteCart берёт
 * base_price/price_override/price_delta/compare_at_price из lib/catalog), и
 * проверенный промокод. Цена НИКОГДА не приходит из тела запроса витрины.
 *
 * Деньги — строки `NUMERIC(14,2)`; вся арифметика идёт в целых копейках
 * (lib/orders/money.ts) → нет ошибок float, корректное округление процентов.
 *
 * Порядок расчёта (детерминированный, §3.1):
 *   1) itemsTotal = Σ(unitPrice × qty), unitPrice — эффективная цена продажи
 *      (НЕ compare_at; «было» — только снимок для чека);
 *   2) discount  = скидка промокода (percent/fixed/free_delivery/bogo), ≤ itemsTotal;
 *   3) delivery  = стоимость доставки с учётом порога бесплатной доставки и
 *      промокода free_delivery (порог сравнивается с itemsTotal − discount);
 *   4) grandTotal = itemsTotal − discount + delivery (≥ 0).
 */

import { fromMinor, percentOfMinor, toMinor, type MoneyString } from './money';
import type { PromoApplyScope, PromoKind } from './types';

// -----------------------------------------------------------------------------
// Вход.
// -----------------------------------------------------------------------------

/**
 * Нормализованная позиция корзины с ценами ИЗ КАТАЛОГА (anti-tamper: цену
 * подставляет сервер, не клиент). Все цены — строки NUMERIC(14,2).
 */
export interface PricedLine {
  /** Снимок названия товара/варианта (для order_items, ADR-010). */
  name: string;
  /** Снимок артикула. */
  sku: string;
  /** Эффективная цена продажи за единицу (что реально платят). */
  unitPrice: MoneyString;
  /** «Было» на момент покупки (compare_at); null → без каталожной акции. */
  compareAt: MoneyString | null;
  /** Количество, целое ≥ 1. */
  qty: number;
  /**
   * Идентификаторы каталога позиции (anti-tamper: сервер проставляет из каталога,
   * НЕ из тела запроса). Опциональны — старые вызовы percent/fixed/free_delivery
   * не обязаны их передавать. Используются только для разметки scope (N×M/scope).
   */
  productId?: string | null;
  variantId?: string | null;
  /** Категории товара (из product_categories) — для scope='category'. */
  categoryIds?: string[];
  /** Бренд товара (products.brand_id) — для scope='brand'. */
  brandId?: string | null;
}

/**
 * Промокод, УЖЕ проверенный (validatePromo вернул valid=true) — pricing только
 * применяет его эффект к итогу. Для percent: value — проценты; для fixed: сумма;
 * для free_delivery: эффект на доставку; bogo — задел (§3.2, Этап 5.2).
 */
export interface AppliedPromo {
  code: string;
  kind: PromoKind;
  /** percent → проценты 0..100; fixed → сумма скидки; иначе игнор. */
  value: MoneyString;
  /** Потолок скидки (для percent); null → без потолка. */
  maxDiscount: MoneyString | null;
  /** Задел под bogo «N по M» (§3.2): «купи N». */
  bogoBuyQty: number | null;
  /** Задел под bogo: «плати за M». */
  bogoPayQty: number | null;
  /** На что распространяется механика (cart/category/brand/set), §5.2. */
  applyScope?: PromoApplyScope;
  /** Qty-порог по линиям scope (дополняет minOrderTotal); null → без порога. */
  minQty?: number | null;
}

/**
 * Резолвнутое множество таргетов акции (anti-tamper: считает СЕРВЕР из каталога,
 * не из тела запроса) — к каким товарам/вариантам применяется scope/N×M.
 * Пустые множества при scope='cart' (вся корзина). Заполняет repository из
 * promo_targets через product_categories / products.brand_id (ADR-014 §4).
 */
export interface PromoScopeTargets {
  categoryIds: Set<string>;
  brandIds: Set<string>;
  productIds: Set<string>;
  variantIds: Set<string>;
}

/**
 * Принадлежит ли линия scope акции (по резолвнутым таргетам). cart → всегда true.
 * Линия попадает в scope, если её variantId/productId напрямую в таргетах ИЛИ её
 * бренд/одна из категорий пересекаются с таргет-множествами (anti-tamper: поля
 * линии заполнены сервером из каталога).
 */
export function lineInScope(
  line: PricedLine,
  scope: PromoApplyScope,
  targets: PromoScopeTargets,
): boolean {
  if (scope === 'cart') return true;

  if (line.variantId && targets.variantIds.has(line.variantId)) return true;
  if (line.productId && targets.productIds.has(line.productId)) return true;
  if (line.brandId && targets.brandIds.has(line.brandId)) return true;
  if (line.categoryIds && line.categoryIds.some((c) => targets.categoryIds.has(c))) {
    return true;
  }
  return false;
}

/**
 * Суммарное кол-во единиц в линиях scope (для сравнения с minQty). Переиспользует
 * lineInScope (та же разметка scope, что в promoScopeDiscountMinor), чтобы
 * валидация minQty (validatePromo) и фактический расчёт скидки опирались на ОДНО И
 * ТО ЖЕ число (баг A волны 7: validatePromo раньше брал кол-во ВСЕЙ корзины, а
 * скидка — только scoped, из-за чего scoped-промокод проходил валидацию, но давал
 * нулевую скидку и зря потреблял лимит). Для scope='cart' это совпадает с Σqty.
 */
export function scopedQty(
  lines: PricedLine[],
  scope: PromoApplyScope,
  targets: PromoScopeTargets,
): number {
  const scoped =
    scope === 'cart' ? lines : lines.filter((l) => lineInScope(l, scope, targets));
  return scoped.reduce(
    (acc, l) => acc + (Number.isInteger(l.qty) && l.qty >= 1 ? l.qty : 0),
    0,
  );
}

/**
 * Скидка применённого промокода в копейках с учётом scope/N×M (docs/11 §5.2).
 * Компонует чистые bogoDiscountMinor/scopeDiscountMinor поверх ПОДМНОЖЕСТВА линий,
 * отфильтрованного по lineInScope (сервер размечает scope, anti-tamper). Для
 * applyScope='cart' + percent/fixed/free_delivery поведение совпадает со старым
 * promoDiscountMinor (аддитивность). Возвращает копейки, clamp ≤ itemsMinor.
 */
export function promoScopeDiscountMinor(
  promo: AppliedPromo | null | undefined,
  lines: PricedLine[],
  targets: PromoScopeTargets,
  itemsMinor: number,
): number {
  if (!promo) return 0;
  const scope = promo.applyScope ?? 'cart';

  // Подмножество линий в scope (для bogo/percent/fixed по таргету).
  const scoped =
    scope === 'cart' ? lines : lines.filter((l) => lineInScope(l, scope, targets));

  // minQty (по единицам scope) — если задан и не достигнут, скидки нет.
  if (promo.minQty != null) {
    const scopedUnits = scoped.reduce(
      (acc, l) => acc + (Number.isInteger(l.qty) && l.qty >= 1 ? l.qty : 0),
      0,
    );
    if (scopedUnits < promo.minQty) return 0;
  }

  let discount: number;
  switch (promo.kind) {
    case 'bogo': {
      if (promo.bogoBuyQty == null || promo.bogoPayQty == null) return 0;
      discount = bogoDiscountMinor(scoped, promo.bogoBuyQty, promo.bogoPayQty);
      break;
    }
    case 'percent':
    case 'fixed': {
      if (scope === 'cart') {
        // Вся корзина — старая семантика (по itemsMinor целиком).
        discount = promoDiscountMinor(promo, itemsMinor);
      } else {
        discount = scopeDiscountMinor(scoped, {
          kind: promo.kind,
          value: promo.value,
          maxDiscount: promo.maxDiscount,
          // minQty уже проверен выше по scope — не дублируем.
        });
      }
      break;
    }
    case 'free_delivery':
    default: {
      // Эффект на доставку (§3.3) — товарной скидки нет.
      discount = 0;
      break;
    }
  }

  return Math.min(Math.max(0, discount), Math.max(0, itemsMinor));
}

/** Параметры расчёта доставки (anti-tamper: cost — серверный, не из запроса). */
export interface DeliveryInput {
  /** Базовая стоимость доставки (СДЭК/заглушка); 0 при самовывозе. */
  cost: MoneyString;
  /** Порог бесплатной доставки (SHOP_FREE_DELIVERY_THRESHOLD); 0 = выключено. */
  freeThreshold: number;
}

/** Полный вход расчёта итога. */
export interface QuoteInput {
  lines: PricedLine[];
  promo?: AppliedPromo | null;
  delivery: DeliveryInput;
  /**
   * Резолвнутые таргеты scope/N×M (anti-tamper: считает сервер из каталога).
   * Опционально — при отсутствии (или applyScope='cart') скидка считается по
   * всей корзине как раньше (percent/fixed/free_delivery — без изменений).
   */
  scopeTargets?: PromoScopeTargets;
}

/** Пустое множество таргетов (scope='cart' / промокода нет). */
export function emptyScopeTargets(): PromoScopeTargets {
  return {
    categoryIds: new Set<string>(),
    brandIds: new Set<string>(),
    productIds: new Set<string>(),
    variantIds: new Set<string>(),
  };
}

// -----------------------------------------------------------------------------
// Выход.
// -----------------------------------------------------------------------------

/** Деталь рассчитанной позиции (для ответа quote и снимка order_items). */
export interface QuoteLine {
  name: string;
  sku: string;
  unitPrice: MoneyString;
  compareAt: MoneyString | null;
  qty: number;
  /** = unitPrice × qty. */
  lineTotal: MoneyString;
  /** Подарочная позиция (промокод gift_*): unitPrice/lineTotal = 0. */
  isGift?: boolean;
}

/**
 * Строит подарочную позицию (товар-подарок промокода gift_*): цена и сумма = 0,
 * `compareAt` = «ценность» подарка (каталожная цена за единицу), `isGift=true`.
 * Чистая функция — подарок считается ОТДЕЛЬНО и добавляется к позициям ПОСЛЕ
 * расчёта итога (не входит в itemsTotal/скидку/порог бесплатной доставки).
 */
export function giftQuoteLine(opts: {
  name: string;
  sku: string;
  /** Каталожная цена подарка за единицу — показывается как «ценность» (было). */
  value: MoneyString | null;
  qty: number;
}): QuoteLine {
  if (!Number.isInteger(opts.qty) || opts.qty < 1) {
    throw new Error(`Некорректное количество подарка "${opts.sku}": ${opts.qty}.`);
  }
  return {
    name: opts.name,
    sku: opts.sku,
    unitPrice: fromMinor(0),
    compareAt: opts.value != null ? fromMinor(toMinor(opts.value)) : null,
    qty: opts.qty,
    lineTotal: fromMinor(0),
    isGift: true,
  };
}

/** Разбивка скидки промокода. */
export interface PromoBreakdown {
  applied: boolean;
  code: string | null;
  kind: PromoKind | null;
  /** Фактическая скидка промокода (для discount_total / promo_redemptions). */
  discount: MoneyString;
}

/** Разбивка доставки. */
export interface DeliveryBreakdown {
  /** Базовая (до бесплатности) стоимость. */
  baseCost: MoneyString;
  /** Итоговая стоимость доставки (0 при бесплатной/самовывозе). */
  cost: MoneyString;
  /** Доставка бесплатна (порог достигнут или промокод free_delivery). */
  free: boolean;
  /** Достигнут ли порог бесплатной доставки по сумме (без учёта промокода). */
  freeThresholdMet: boolean;
}

/** Итог расчёта корзины (серверный, anti-tamper). */
export interface QuoteResult {
  lines: QuoteLine[];
  /** Σ lineTotal. */
  itemsTotal: MoneyString;
  /** Скидка промокода (не доставка). */
  discount: MoneyString;
  /** Стоимость доставки. */
  deliveryCost: MoneyString;
  /** itemsTotal − discount + deliveryCost. */
  grandTotal: MoneyString;
  promo: PromoBreakdown;
  delivery: DeliveryBreakdown;
}

// -----------------------------------------------------------------------------
// Эффективная цена позиции из каталога (anti-tamper источник, §3.1).
// -----------------------------------------------------------------------------

/**
 * Эффективная цена ПРОДАЖИ за единицу в копейках (что реально платят):
 *  - вариант с price_override → price_override;
 *  - вариант без override → base_price + price_delta;
 *  - товар без варианта → base_price.
 *
 * Считается в целых копейках (без float). НЕ возвращает compare_at — «было»
 * берётся отдельно (effectiveCompareAt каталога) и идёт только в снимок чека.
 */
export function effectiveUnitPriceMinor(opts: {
  basePrice: MoneyString;
  priceOverride?: MoneyString | null;
  priceDelta?: MoneyString | null;
}): number {
  if (opts.priceOverride != null) {
    return toMinor(opts.priceOverride);
  }
  const base = toMinor(opts.basePrice);
  const delta = opts.priceDelta != null ? toMinor(opts.priceDelta) : 0;
  return base + delta;
}

// -----------------------------------------------------------------------------
// Расчёт позиции и суммы товаров.
// -----------------------------------------------------------------------------

/**
 * Сумма позиции в копейках = unitPrice × qty (целочисленно).
 *
 * Защита точности (Fix 2): произведение копеек на qty считается в number; если
 * оно превышает Number.MAX_SAFE_INTEGER, целочисленная арифметика перестаёт быть
 * точной (тихая потеря последних разрядов суммы). Верхняя граница qty в схемах
 * (quantitySchema .max(10000)) делает это практически недостижимым, но здесь —
 * последний рубеж: при переполнении бросаем явную ошибку, а не пишем «битую» сумму.
 */
export function lineTotalMinor(line: PricedLine): number {
  if (!Number.isInteger(line.qty) || line.qty < 1) {
    throw new Error(`Некорректное количество позиции "${line.sku}": ${line.qty}.`);
  }
  const total = toMinor(line.unitPrice) * line.qty;
  if (total > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `Переполнение суммы позиции "${line.sku}": цена × количество (${line.qty}) ` +
        'превышает безопасный диапазон вычислений.',
    );
  }
  return total;
}

/** Сумма всех позиций в копейках. */
export function itemsTotalMinor(lines: PricedLine[]): number {
  return lines.reduce((acc, l) => acc + lineTotalMinor(l), 0);
}

// -----------------------------------------------------------------------------
// Применение промокода (поверх itemsTotal; §3.2). Чистая функция.
// -----------------------------------------------------------------------------

/**
 * Скидка промокода в копейках по itemsTotal (копейки). Не больше itemsTotal.
 *  - percent: round(itemsMinor × value/100), обрезано maxDiscount;
 *  - fixed:   min(value, itemsMinor);
 *  - free_delivery: 0 (эффект — на доставку, §3.3);
 *  - bogo: ЗАДЕЛ (§3.2) — расчёт «дешёвая бесплатно» отложен в Этап 5.2; здесь 0.
 */
export function promoDiscountMinor(
  promo: AppliedPromo | null | undefined,
  itemsMinor: number,
): number {
  if (!promo) return 0;

  let discount = 0;
  switch (promo.kind) {
    case 'percent': {
      const pct = Number(promo.value);
      discount = percentOfMinor(itemsMinor, pct);
      if (promo.maxDiscount != null) {
        discount = Math.min(discount, toMinor(promo.maxDiscount));
      }
      break;
    }
    case 'fixed': {
      discount = Math.min(toMinor(promo.value), itemsMinor);
      break;
    }
    case 'free_delivery': {
      // Скидки на товары нет — эффект применяется к доставке (§3.3).
      discount = 0;
      break;
    }
    case 'bogo': {
      // TODO(Этап 5.2): движок «N по M» — на каждые bogoBuyQty одинаковых
      // позиций бесплатна (bogoBuyQty − bogoPayQty) самых дешёвых (docs/07 §3.2).
      // Модель заложена (поля bogoBuyQty/bogoPayQty), исполнение отложено.
      discount = 0;
      break;
    }
  }
  // Скидка промокода не может превышать сумму товаров (§3.1.2).
  return Math.min(Math.max(0, discount), itemsMinor);
}

// -----------------------------------------------------------------------------
// N×M «N по M» (BOGO) — чистый расчёт (docs/11 §5.2, Пакет 5.P-1).
// -----------------------------------------------------------------------------

/**
 * Скидка «купи N плати M» в копейках по набору линий (в пределах scope).
 *
 * Алгоритм (детерминированный):
 *  - линии разворачиваются в поштучные цены (qty копий цены за единицу);
 *  - totalQty = Σqty; freeGroups = floor(totalQty / buyQty);
 *  - freeUnits = freeGroups × (buyQty − payQty);
 *  - бесплатны САМЫЕ ДЕШЁВЫЕ freeUnits единиц во всём наборе → их сумма.
 *
 * Защита: payQty ≥ buyQty или buyQty < 1 → 0; пустой набор → 0. Целые копейки.
 */
export function bogoDiscountMinor(
  lines: PricedLine[],
  buyQty: number,
  payQty: number,
): number {
  if (!Number.isInteger(buyQty) || buyQty < 1) return 0;
  if (!Number.isInteger(payQty) || payQty < 0 || payQty >= buyQty) return 0;

  // Разворачиваем линии в поштучные цены (копейки).
  const units: number[] = [];
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 1) continue;
    const unitMinor = toMinor(line.unitPrice);
    for (let i = 0; i < line.qty; i += 1) {
      units.push(unitMinor);
    }
  }
  if (units.length === 0) return 0;

  const totalQty = units.length;
  const freeGroups = Math.floor(totalQty / buyQty);
  if (freeGroups <= 0) return 0;

  const freeUnits = freeGroups * (buyQty - payQty);
  if (freeUnits <= 0) return 0;

  // Бесплатны самые дешёвые freeUnits единиц во всём наборе.
  units.sort((a, b) => a - b);
  let discount = 0;
  for (let i = 0; i < freeUnits && i < units.length; i += 1) {
    discount += units[i];
  }
  return discount;
}

// -----------------------------------------------------------------------------
// Scope-скидка percent/fixed по подмножеству линий (docs/11 §5.2, Пакет 5.P-1).
// -----------------------------------------------------------------------------

/**
 * Скидка percent/fixed по сумме УЖЕ отфильтрованных под scope линий (anti-tamper:
 * принадлежность scope определяет сервер из каталога, не тело запроса).
 *  - percent: round(scoped × value/100), обрезка maxDiscount;
 *  - fixed:   min(value, scoped);
 *  - minQty (опц.): если Σqty линий < minQty → 0.
 * Итог clamp в [0, scopedItemsMinor]. Целые копейки.
 */
export function scopeDiscountMinor(
  lines: PricedLine[],
  opts: {
    kind: 'percent' | 'fixed';
    value: MoneyString;
    maxDiscount?: MoneyString | null;
    minQty?: number | null;
  },
): number {
  const scopedMinor = itemsTotalMinor(lines);
  if (scopedMinor <= 0) return 0;

  if (opts.minQty != null) {
    const totalQty = lines.reduce(
      (acc, l) => acc + (Number.isInteger(l.qty) && l.qty >= 1 ? l.qty : 0),
      0,
    );
    if (totalQty < opts.minQty) return 0;
  }

  let discount = 0;
  if (opts.kind === 'percent') {
    discount = percentOfMinor(scopedMinor, Number(opts.value));
    if (opts.maxDiscount != null) {
      discount = Math.min(discount, toMinor(opts.maxDiscount));
    }
  } else {
    discount = Math.min(toMinor(opts.value), scopedMinor);
  }

  return Math.min(Math.max(0, discount), scopedMinor);
}

// -----------------------------------------------------------------------------
// Комбинируемость промо-скидок (docs/11 §5.2, Пакет 5.P-1). Чистая функция.
// -----------------------------------------------------------------------------

/** Промо-скидка-кандидат для комбинирования (уже посчитана в копейках). */
export interface CombinableDiscount {
  code: string;
  priority: number;
  stackable: boolean;
  discountMinor: number;
}

/**
 * Комбинирует промо-скидки по MVP-правилу: все stackable + ≤1 не-stackable
 * (выбор по priority asc, tie-break code asc). Сумма выбранных discountMinor,
 * clamp в [0, itemsMinor]. Детерминирован (не зависит от порядка входа).
 */
export function combineDiscountsMinor(
  discounts: CombinableDiscount[],
  itemsMinor: number,
): { totalMinor: number; appliedCodes: string[] } {
  const stackable = discounts.filter((d) => d.stackable);

  // Один не-stackable: min priority, tie-break code asc (детерминированно).
  const exclusive = discounts
    .filter((d) => !d.stackable)
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code))[0];

  const selected = exclusive ? [exclusive, ...stackable] : [...stackable];

  const sum = selected.reduce((acc, d) => acc + Math.max(0, d.discountMinor), 0);
  const totalMinor = Math.min(Math.max(0, sum), Math.max(0, itemsMinor));

  return {
    totalMinor,
    appliedCodes: selected.map((d) => d.code),
  };
}

// -----------------------------------------------------------------------------
// Доставка и порог бесплатной доставки (§3.3). Чистая функция.
// -----------------------------------------------------------------------------

/**
 * Стоимость доставки в копейках с учётом порога и промокода free_delivery.
 * Порог сравнивается с суммой ПОСЛЕ скидки промокода (itemsMinor − discountMinor).
 * Возвращает разбивку: итоговая стоимость + признаки бесплатности.
 *
 * scopeHasMatch (баг #10, защита легаси-данных): для scoped промокода
 * free_delivery (applyScope ≠ cart) бесплатная доставка применяется ТОЛЬКО если
 * в корзине реально есть товар в scope. Признак вычисляет вызывающий код
 * (calculateQuote по lineInScope) и передаёт сюда. По умолчанию (флаг не передан)
 * или для applyScope='cart' поведение прежнее — free_delivery всегда обнуляет
 * доставку. Создать scoped free_delivery нельзя (refinePromo запрещает), флаг —
 * страховка для уже существующих в БД легаси-записей.
 */
export function resolveDelivery(
  delivery: DeliveryInput,
  netItemsMinor: number,
  promo: AppliedPromo | null | undefined,
  scopeHasMatch?: boolean,
): { costMinor: number; free: boolean; freeThresholdMet: boolean } {
  const baseCostMinor = toMinor(delivery.cost);

  // Порог: 0 (или отрицательный) = выключено → никогда не «бесплатно по порогу».
  const thresholdMinor =
    delivery.freeThreshold > 0 ? toMinor(delivery.freeThreshold) : Number.POSITIVE_INFINITY;
  const freeThresholdMet =
    Number.isFinite(thresholdMinor) && netItemsMinor >= thresholdMinor;

  // free_delivery: для applyScope='cart' (по умолчанию) — всегда; для scoped —
  // только если в scope есть подходящий товар (scopeHasMatch). Флаг не передан →
  // считаем true (обратная совместимость с вызовами без scope).
  const scope = promo?.applyScope ?? 'cart';
  const promoFreeDelivery =
    promo?.kind === 'free_delivery' &&
    (scope === 'cart' || scopeHasMatch !== false);
  const free = freeThresholdMet || promoFreeDelivery;

  return {
    costMinor: free ? 0 : baseCostMinor,
    free,
    freeThresholdMet,
  };
}

// -----------------------------------------------------------------------------
// Полный расчёт итога (компонует всё выше). Чистая функция — anti-tamper ядро.
// -----------------------------------------------------------------------------

/**
 * Серверный расчёт корзины: позиции → товары → промокод → доставка → итог.
 * Полностью детерминированный и тестируемый без БД (матрица).
 */
export function calculateQuote(input: QuoteInput): QuoteResult {
  const { lines, promo, delivery } = input;
  const scopeTargets = input.scopeTargets ?? emptyScopeTargets();

  // 1) Позиции и сумма товаров.
  const quoteLines: QuoteLine[] = lines.map((l) => {
    const ltMinor = lineTotalMinor(l);
    return {
      name: l.name,
      sku: l.sku,
      unitPrice: fromMinor(toMinor(l.unitPrice)),
      compareAt: l.compareAt != null ? fromMinor(toMinor(l.compareAt)) : null,
      qty: l.qty,
      lineTotal: fromMinor(ltMinor),
    };
  });
  const itemsMinor = quoteLines.reduce((acc, l) => acc + toMinor(l.lineTotal), 0);

  // 2) Скидка промокода (поверх товаров): scope/N×M-aware. Для applyScope='cart'
  //    + percent/fixed/free_delivery поведение совпадает с promoDiscountMinor
  //    (аддитивность); bogo и scope≠cart считаются по подмножеству линий target.
  const discountMinor = promoScopeDiscountMinor(promo, lines, scopeTargets, itemsMinor);

  // 3) Доставка (порог сравнивается с суммой после скидки). Для scoped
  //    free_delivery (баг #10) считаем, есть ли в корзине товар в scope —
  //    бесплатная доставка применяется только тогда (защита легаси-данных;
  //    создать scoped free_delivery нельзя, см. refinePromo).
  const netItemsMinor = itemsMinor - discountMinor;
  let scopeHasMatch: boolean | undefined;
  if (promo?.kind === 'free_delivery' && (promo.applyScope ?? 'cart') !== 'cart') {
    scopeHasMatch = lines.some((l) =>
      lineInScope(l, promo.applyScope ?? 'cart', scopeTargets),
    );
  }
  const del = resolveDelivery(delivery, netItemsMinor, promo, scopeHasMatch);

  // 4) Итог.
  const grandMinor = itemsMinor - discountMinor + del.costMinor;
  if (grandMinor < 0) {
    throw new Error('Ошибка расчёта: итог заказа отрицателен.');
  }

  // free_delivery «применён» только если он РЕАЛЬНО дал выгоду по доставке:
  //  • scope подходит (cart, либо scoped с товаром в scope), И
  //  • базовая доставка была платной (cost > 0 — самовывоз/stub 0.00 выгоды не даёт), И
  //  • доставка НЕ была бы бесплатна по порогу и без промокода (freeThresholdMet=false).
  // Иначе промокод эффекта не оказал → applied=false (m4: не сжигаем usage_limit /
  // не пишем promo_redemptions за нулевую выгоду; redemption гейтится quote.promo.applied).
  const freeDeliveryApplied =
    promo?.kind === 'free_delivery' &&
    ((promo.applyScope ?? 'cart') === 'cart' || scopeHasMatch === true) &&
    toMinor(delivery.cost) > 0 &&
    del.freeThresholdMet === false;
  const promoApplied = Boolean(promo) && (discountMinor > 0 || freeDeliveryApplied);

  return {
    lines: quoteLines,
    itemsTotal: fromMinor(itemsMinor),
    discount: fromMinor(discountMinor),
    deliveryCost: fromMinor(del.costMinor),
    grandTotal: fromMinor(grandMinor),
    promo: {
      applied: promoApplied,
      code: promo && promoApplied ? promo.code : null,
      kind: promo && promoApplied ? promo.kind : null,
      discount: fromMinor(discountMinor),
    },
    delivery: {
      baseCost: fromMinor(toMinor(delivery.cost)),
      cost: fromMinor(del.costMinor),
      free: del.free,
      freeThresholdMet: del.freeThresholdMet,
    },
  };
}
