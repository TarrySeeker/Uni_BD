/**
 * Сборка чека 54-ФЗ Init.Receipt (docs/15 §6). ЧИСТАЯ функция, без сети/БД.
 *
 * Включается только при TBANK_RECEIPT_ENABLED=true (к терминалу подключена
 * онлайн-касса). По умолчанию ВЫКЛЮЧЕНО — buildReceipt вызывается лишь когда
 * receiptEnabled, иначе Receipt в Init не идёт (volna 3, опц.).
 *
 * ИНВАРИАНТ (docs/15 §6, критично): сумма всех Items.Amount ДОЛЖНА равняться
 * Init.Amount (иначе Т-Банк отклонит). Доставка (>0) — отдельной позицией.
 * Суммы — целые КОПЕЙКИ.
 */

import type { Order, OrderItem } from '@/lib/orders/types';
import { toMinor } from '@/lib/orders/money';
import { TbankError } from './errors';
import type { TbankConfig } from './config';
import type { TbankReceipt, TbankReceiptItem } from './types';

/**
 * Рубли-строка NUMERIC(14,2) → целые копейки через ТОЧНЫЙ строковый разбор
 * (toMinor, инвариант денег ADR-010) — без float (`Number(x)*100`), чтобы
 * '19.99' → 1999 строго. toMinor бросает на невалидном/отрицательном/более 2
 * знаков входе; здесь — мягкая обёртка (как раньше toKopecks возвращал 0),
 * т.к. сборка чека не должна падать на «грязной» сумме (вызывающий проверит
 * инвариант Σ = Init.Amount отдельно).
 */
export function toKopecks(numericRubles: string | number): number {
  try {
    return toMinor(numericRubles);
  } catch {
    return 0;
  }
}

/**
 * Собирает Receipt из заказа + позиций. Email/Phone — из заказа (одно из двух
 * обязательно). Taxation — из config (TBANK_TAXATION); Tax позиции — defaultTax
 * (TBANK_DEFAULT_TAX). Доставка (deliveryTotal>0) добавляется позицией «Доставка»
 * (PaymentObject:'service'). Возвращает null, если нет ни email, ни телефона
 * (чек невозможен) или taxation не задан.
 */
export function buildReceipt(
  order: Order,
  items: OrderItem[],
  cfg: TbankConfig,
): TbankReceipt | null {
  if (!cfg.taxation) return null;
  const email = order.customerEmail?.trim() || undefined;
  const phone = order.customerPhone?.trim() || undefined;
  if (!email && !phone) return null;

  // Сумма к оплате = Init.Amount: считаем из grand_total (anti-tamper, как в
  // service.initPayment). Именно к ней ДОЛЖНА сойтись Σ Items.Amount (docs/15 §6).
  const amountKop = toKopecks(order.grandTotal);

  // Исходные суммы позиций (в копейках, эффективная unitPrice × quantity).
  const lineAmounts = items.map((it) => toKopecks(it.unitPrice) * it.quantity);
  const itemsTotalKop = lineAmounts.reduce((a, b) => a + b, 0);

  // Скидка уровня заказа (промокод) — распределяем ТОЛЬКО по товарам, не по
  // доставке (доставка — отдельная услуга, в чеке полной стоимостью). 54-ФЗ:
  // цена позиции должна учитывать скидку, иначе Σ Amount > Init.Amount и Т-Банк
  // отклонит Init. Распределяем пропорционально доле позиции с корректным
  // распределением остатка округления (largest remainder), чтобы Σ совпала точно.
  const discountKop = toKopecks(order.discountTotal);
  const discounted = distributeDiscount(lineAmounts, discountKop, itemsTotalKop);

  const receiptItems: TbankReceiptItem[] = items.map((it, i) => {
    const lineAmount = discounted[i]!;
    if (discountKop > 0) {
      // Со скидкой: одна позиция = одна строка чека (Quantity:1), цена = итог по
      // строке. Сохраняет инвариант Amount === Price × Quantity без дробной
      // копейки на единицу (54-ФЗ допускает Price за позицию при Quantity:1).
      return {
        Name: it.nameSnapshot.slice(0, 128),
        Quantity: 1,
        Price: lineAmount,
        Amount: lineAmount,
        Tax: cfg.defaultTax,
        PaymentMethod: 'full_payment',
        PaymentObject: 'commodity',
      };
    }
    // Без скидки — поштучная цена (исходное поведение).
    const price = toKopecks(it.unitPrice);
    return {
      Name: it.nameSnapshot.slice(0, 128),
      Quantity: it.quantity,
      Price: price,
      Amount: price * it.quantity,
      Tax: cfg.defaultTax,
      PaymentMethod: 'full_payment',
      PaymentObject: 'commodity',
    };
  });

  const deliveryKop = toKopecks(order.deliveryTotal);
  if (deliveryKop > 0) {
    receiptItems.push({
      Name: 'Доставка',
      Quantity: 1,
      Price: deliveryKop,
      Amount: deliveryKop,
      Tax: cfg.defaultTax,
      PaymentMethod: 'full_payment',
      PaymentObject: 'service',
    });
  }

  const receipt: TbankReceipt = {
    ...(email ? { Email: email } : {}),
    ...(phone ? { Phone: phone } : {}),
    Taxation: cfg.taxation,
    Items: receiptItems,
  };

  // ИНВАРИАНТ (docs/15 §6, критично): Σ Items.Amount === Init.Amount. Сверяем
  // ВСЕГДА — расхождение здесь означает баг распределения/округления; лучше
  // упасть на нашей стороне с понятной ошибкой, чем получить отказ Init от
  // Т-Банка. amountKop=0 (грязный grand_total) не проверяем (Init упадёт раньше
  // по tbank_invalid_amount).
  const total = receiptTotalKop(receipt);
  if (amountKop > 0 && total !== amountKop) {
    throw new TbankError(
      'tbank_receipt_mismatch',
      `Сумма позиций чека (${total} коп.) не равна Init.Amount (${amountKop} коп.). ` +
        'Нарушен инвариант 54-ФЗ (docs/15 §6) — Т-Банк отклонит Init.',
    );
  }

  return receipt;
}

/**
 * Распределяет скидку заказа (discountKop) по суммам позиций (lineAmounts)
 * пропорционально их доле, с распределением остатка округления методом
 * наибольшего остатка (largest remainder), чтобы Σ итоговых сумм точно равнялась
 * (itemsTotalKop − discountKop). Возвращает новые суммы позиций (≥0).
 *
 * Чистая функция. При discountKop ≤ 0 или нулевом itemsTotalKop возвращает
 * исходные суммы без изменений.
 */
function distributeDiscount(
  lineAmounts: number[],
  discountKop: number,
  itemsTotalKop: number,
): number[] {
  if (discountKop <= 0 || itemsTotalKop <= 0) return lineAmounts.slice();
  // Скидка не может превышать сумму позиций (домен это гарантирует, но защищаемся).
  const effective = Math.min(discountKop, itemsTotalKop);

  // 1) Базовая доля скидки на позицию (округление вниз) + дробные остатки.
  const raw = lineAmounts.map((amt) => (amt * effective) / itemsTotalKop);
  const floors = raw.map((x) => Math.floor(x));
  let allocated = floors.reduce((a, b) => a + b, 0);
  let remainder = effective - allocated; // сколько копеек скидки ещё не роздано

  // 2) Раздаём остаток по 1 копейке позициям с наибольшей дробной частью.
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const extra = new Array<number>(lineAmounts.length).fill(0);
  for (let k = 0; k < order.length && remainder > 0; k++) {
    extra[order[k]!.i] = 1;
    remainder--;
  }

  // 3) Итоговые суммы позиций = исходная − (floor-доля + остаток-копейка), ≥0.
  return lineAmounts.map((amt, i) => Math.max(0, amt - floors[i]! - extra[i]!));
}

/** Сумма всех Items.Amount чека (для проверки инварианта = Init.Amount). */
export function receiptTotalKop(receipt: TbankReceipt): number {
  return receipt.Items.reduce((acc, it) => acc + it.Amount, 0);
}
