/**
 * Деньги и состав чека АТОЛ Pay. ЧИСТЫЙ модуль: ни сети, ни БД.
 *
 * Вынесено из сервиса намеренно — это единственная арифметика во всей
 * интеграции, где ошибка в одну копейку останавливает оплату
 * (INVALID_RECEIPT_AMOUNT: сумма платежа обязана сойтись с суммой позиций).
 */

import { logger } from '@/lib/logger';
import type { Order, OrderItem } from '@/lib/orders/types';
import type { AtolPosition } from './types';

const log = logger.child({ module: 'payments/atol/money' });

/** Количество в чеке измеряется тысячными долями единицы. */
const THOUSANDTHS = 1000;

/** Предел длины названия позиции в чеке. */
const MAX_NAME_LEN = 128;

/** Фискальные реквизиты позиций — приходят из конфигурации магазина. */
export interface FiscalProps {
  sno: number;
  tax: number;
  productSubject: number;
  deliverySubject: number;
  paymentMethod: number;
}

/**
 * Рубли-строка (NUMERIC) → копейки-целое.
 *
 * Через строковый разбор, а не через float: 0.1 + 0.2 в двоичной плавающей
 * точке не равно 0.3, и на суммах заказа это даёт расхождение в копейку,
 * из-за которого эквайер отвергает платёж. (Тот же приём, что в Озоне.)
 */
export function rublesToKopecks(value: string | number): number {
  const s = String(value).trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;

  // 🔴 Мусор на входе — ОШИБКА, а не «ноль копеек». Раньше здесь стоял
  // `if (!Number.isFinite(kop)) return 0`, и это опасный дефолт: нулевая
  // «сумма заказа» превращает сверку недоплаты в тождественно истинную
  // (ничто не меньше нуля), то есть глушит ровно ту проверку, которая
  // защищает деньги. Лучше упасть на разборе, чем засчитать оплату.
  if (!/^\d+(\.\d*)?$/.test(body)) {
    throw new Error(`Невалидная сумма: ${JSON.stringify(value)}`);
  }

  const [intPart = '0', fracRaw = ''] = body.split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  const kop = Number.parseInt(intPart, 10) * 100 + Number.parseInt(frac, 10);
  return neg ? -kop : kop;
}

/**
 * Штуки → тысячные доли.
 *
 * 🔴 999 шт передаются как 999000. Отправить «999» значит пробить чек на
 * 0,999 штуки и получить несходящуюся сумму.
 */
export function unitsToThousandths(qty: number): number {
  return Math.round(qty * THOUSANDTHS);
}

/**
 * Разносит скидку по позициям пропорционально их стоимости.
 *
 * 🔴 ЗАЧЕМ ВООБЩЕ РАЗНОСИТЬ. У Озона при наличии скидки чек уходил
 * «сокращённым» — без состава. У АТОЛа такого режима нет: сумма позиций
 * обязана совпасть с суммой платежа, иначе INVALID_RECEIPT_AMOUNT. Значит
 * скидку нужно вычесть из позиций, а не приложить отдельной строкой
 * (отрицательных позиций в чеке не бывает).
 *
 * 🔴 ОСТАТОК. 100 ₽ на 3 позиции нацело не делятся. Пропорциональные доли
 * округляются вниз, а накопившийся остаток дораспределяется по одной копейке —
 * иначе теряются копейки и сумма не сходится.
 */
function spreadDiscount(lineKops: number[], discountKop: number): number[] {
  const total = lineKops.reduce((a, b) => a + b, 0);
  if (discountKop <= 0 || total <= 0) return lineKops;

  const shares = lineKops.map((kop) => Math.floor((kop * discountKop) / total));
  let rest = discountKop - shares.reduce((a, b) => a + b, 0);

  // Остаток раздаём по копейке, начиная с самых дорогих позиций: так скидка не
  // «съедает» дешёвую позицию целиком и не уводит её цену в минус.
  const order = lineKops
    .map((kop, i) => ({ i, kop }))
    .sort((a, b) => b.kop - a.kop)
    .map((x) => x.i);

  for (let pass = 0; rest > 0 && pass < THOUSANDTHS; pass += 1) {
    for (const i of order) {
      if (rest === 0) break;
      if (shares[i] < lineKops[i]) {
        shares[i] += 1;
        rest -= 1;
      }
    }
  }

  return lineKops.map((kop, i) => kop - shares[i]);
}

/**
 * Собирает позиции чека: товары + доставка отдельной услугой.
 *
 * Возвращает null, если сумму позиций не удалось свести с итогом заказа.
 * 🔴 Молча отправить несходящийся чек нельзя: в лучшем случае это отказ АТОЛа,
 * в худшем — пробитый чек с неверной суммой, то есть нарушение 54-ФЗ.
 */
export function buildPositions(
  order: Order,
  items: OrderItem[],
  fiscal: FiscalProps,
): AtolPosition[] | null {
  const grandKop = rublesToKopecks(order.grandTotal);
  const discountKop = rublesToKopecks(order.discountTotal);
  const deliveryKop = rublesToKopecks(order.deliveryTotal);

  // Стоимость строк в копейках — база для разноса скидки.
  const lineKops = items.map((it) => rublesToKopecks(it.unitPrice) * it.quantity);
  const afterDiscount = spreadDiscount(lineKops, discountKop);

  const positions: AtolPosition[] = items.map((it, i) => {
    const qty = it.quantity > 0 ? it.quantity : 1;
    const lineKop = afterDiscount[i];
    // Цена за единицу — целое число копеек: дробных копеек в чеке не бывает.
    const unitKop = Math.floor(lineKop / qty);
    return {
      name: it.nameSnapshot.slice(0, MAX_NAME_LEN),
      price: unitKop,
      quantity: unitsToThousandths(qty),
      measure: 0,
      paymentMethod: fiscal.paymentMethod,
      paymentSubject: fiscal.productSubject,
      tax: fiscal.tax,
    };
  });

  if (deliveryKop > 0) {
    positions.push({
      name: 'Доставка',
      price: deliveryKop,
      quantity: unitsToThousandths(1),
      measure: 0,
      paymentMethod: fiscal.paymentMethod,
      // 3 = услуга: доставка не товар, это разные признаки предмета расчёта.
      paymentSubject: fiscal.deliverySubject,
      tax: fiscal.tax,
    });
  }

  const sumOf = (list: AtolPosition[]) =>
    list.reduce((acc, p) => acc + (p.price * p.quantity) / THOUSANDTHS, 0);

  /**
   * Целочисленное деление цены за единицу могло отбросить копейки (999 копеек
   * на 2 штуки). Добираем разницу — но СТРОГО в пределах округления, не больше
   * копейки на каждую единицу товара.
   *
   * 🔴 Граница здесь принципиальна. Без неё код «подгонял» бы чек под любой
   * итог: заказ с рассогласованными данными (итог не выводится из состава)
   * дал бы внешне сходящийся чек с НЕВЕРНЫМИ ценами — то есть пробитый чек,
   * не соответствующий сделке. Лучше не отправить чек вовсе и разобраться,
   * чем отправить правдоподобный неверный.
   */
  const roundingBudget = positions.reduce((acc, p) => acc + p.quantity / THOUSANDTHS, 0);
  let diff = grandKop - sumOf(positions);

  if (diff !== 0 && Math.abs(diff) <= roundingBudget) {
    for (const p of positions) {
      if (diff === 0) break;
      const qty = p.quantity / THOUSANDTHS;
      if (qty !== 1 || p.price <= 0) continue;
      const step = diff > 0 ? Math.min(diff, 1) : Math.max(diff, -1);
      p.price += step;
      diff -= step;
    }
  }

  const sum = sumOf(positions);
  if (sum !== grandKop || !Number.isInteger(sum)) {
    // Сюда попадаем, если итог заказа не выводится из его же состава — это
    // рассогласование данных заказа, а не проблема эквайринга.
    log.warn('atol: сумма позиций не сошлась с итогом заказа — чек не отправляем', {
      orderNumber: order.number,
      sumKop: sum,
      grandKop,
      discountKop,
      deliveryKop,
    });
    return null;
  }

  return positions;
}
