/**
 * Чистый контракт ручного создания заказа из админки (Batch 4 аудита, F4).
 *
 * Здесь НЕТ React/БД — только чистые функции преобразования состояния формы в
 * payload под ManualOrderSchema и маппинга ответа createManualOrder. Это позволяет
 * покрыть сборку payload и маппинг юнит-тестами (tests/orders/manual-order-form.test.ts),
 * не поднимая ни компонент, ни базу.
 *
 * Анти-tamper (ADR-010): форма НЕ передаёт цены/итог — только variantId/productId,
 * qty, контакты, выбор доставки и оплаты. Сервер сам ре-валидирует цены/остатки/
 * резерв в createManualOrder → createOrder(source='admin'). Поэтому здесь нет полей
 * цены, и промежуточный итог для UI (`estimateItemsTotalMinor`) — лишь подсказка
 * оператору, не источник правды.
 */

import { fromMinor } from './money';
import { effectiveUnitPriceMinor } from './pricing';
import type { DeliveryType, PaymentMethod } from './types';

/** Строка позиции в состоянии формы (то, что собирает оператор в UI). */
export interface ManualOrderFormLine {
  /** Идентификатор товара (для товара без вариантов). */
  productId?: string;
  /** Идентификатор варианта (приоритетнее productId). */
  variantId?: string;
  /** Кол-во единиц; в форме хранится строкой инпута, нормализуется в число. */
  qty: number;
}

/** Состояние формы ручного заказа целиком. */
export interface ManualOrderFormState {
  items: ManualOrderFormLine[];
  customer: {
    name: string;
    email: string;
    phone: string;
  };
  delivery: {
    type: DeliveryType;
    city?: string;
    address?: string;
    pvzCode?: string;
  };
  paymentMethod: PaymentMethod;
  comment?: string;
}

/**
 * Payload ровно того shape, что ждёт ManualOrderSchema (= CreateOrderSchema +
 * source). Опущенные опциональные поля НЕ включаются (а не передаются пустой
 * строкой), чтобы пройти Zod-валидацию без лишних '' в city/address.
 */
export interface ManualOrderPayload {
  items: Array<{ productId?: string; variantId?: string; qty: number }>;
  customer: { name: string; email: string; phone: string };
  delivery: {
    type: DeliveryType;
    city?: string;
    address?: string;
    pvzCode?: string;
  };
  paymentMethod: PaymentMethod;
  comment?: string;
  source: 'admin';
}

function trimmedOrUndefined(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Нормализует выбор доставки по типу: для каждого типа оставляет только
 * релевантные поля. Так оператор не «протащит» pvzCode в курьерскую доставку,
 * а пустые строки не уйдут в payload (Zod на сервере проверит обязательность
 * pvzCode для type='pvz').
 *
 *  - courier: city + address (адрес обязателен по смыслу, но обязательность —
 *    на стороне сервера/quote; здесь просто не отбрасываем заполненное);
 *  - pvz: city + pvzCode (код ПВЗ);
 *  - pickup: ничего, кроме type (самовывоз с витрины магазина).
 */
export function normalizeDelivery(
  delivery: ManualOrderFormState['delivery'],
): ManualOrderPayload['delivery'] {
  const type = delivery.type;
  if (type === 'pickup') {
    return { type };
  }
  if (type === 'pvz') {
    const out: ManualOrderPayload['delivery'] = { type };
    const city = trimmedOrUndefined(delivery.city);
    const pvzCode = trimmedOrUndefined(delivery.pvzCode);
    if (city) out.city = city;
    if (pvzCode) out.pvzCode = pvzCode;
    return out;
  }
  // courier
  const out: ManualOrderPayload['delivery'] = { type: 'courier' };
  const city = trimmedOrUndefined(delivery.city);
  const address = trimmedOrUndefined(delivery.address);
  if (city) out.city = city;
  if (address) out.address = address;
  return out;
}

/**
 * Собирает payload под ManualOrderSchema из состояния формы.
 *
 * - позиции: оставляем variantId ИЛИ productId (variantId приоритетен) + qty;
 *   строки без идентификатора отбрасываются (защита от «пустых» строк формы);
 * - контакты: trim;
 * - доставка: нормализуется по типу (см. normalizeDelivery);
 * - comment: trim, опускается если пуст;
 * - source: 'admin' (признак ручного заказа).
 *
 * Деньги/итог НЕ кладём (ADR-010): сервер посчитает сам.
 */
export function buildManualOrderPayload(state: ManualOrderFormState): ManualOrderPayload {
  const items = state.items
    .map((line) => {
      const out: { productId?: string; variantId?: string; qty: number } = { qty: line.qty };
      const variantId = trimmedOrUndefined(line.variantId);
      const productId = trimmedOrUndefined(line.productId);
      // variantId приоритетен; иначе productId. Если нет ни того, ни другого —
      // строка считается пустой и отбрасывается ниже.
      if (variantId) {
        out.variantId = variantId;
      } else if (productId) {
        out.productId = productId;
      }
      return out;
    })
    .filter((line) => Boolean(line.variantId) || Boolean(line.productId));

  const payload: ManualOrderPayload = {
    items,
    customer: {
      name: state.customer.name.trim(),
      email: state.customer.email.trim(),
      phone: state.customer.phone.trim(),
    },
    delivery: normalizeDelivery(state.delivery),
    paymentMethod: state.paymentMethod,
    source: 'admin',
  };

  const comment = trimmedOrUndefined(state.comment);
  if (comment) {
    payload.comment = comment;
  }

  return payload;
}

/** Ответ createManualOrder (success-ветка ActionResult.data). */
export interface ManualOrderResponse {
  id: string;
  number: string;
}

/**
 * Маппинг ответа экшена в минимальные поля, нужные UI после успеха (id для
 * редиректа на карточку, number — для тоста/уведомления). Терпим к лишним полям
 * (экшен возвращает ещё и order), берём только нужное.
 */
export function mapCreateOrderResponse(data: {
  id: string;
  number: string;
}): ManualOrderResponse {
  return { id: data.id, number: data.number };
}

/** URL карточки созданного заказа (единый источник пути для редиректа). */
export function createdOrderPath(id: string): string {
  return `/admin/orders/${id}`;
}

/**
 * Данные позиции для оценки промежуточного итога в UI (подсказка оператору).
 * Цена берётся из каталога на стороне сервера-страницы и передаётся в форму как
 * выбранный товар/вариант; здесь только арифметика для предпросмотра.
 */
export interface EstimateLine {
  basePrice: string;
  priceOverride?: string | null;
  priceDelta?: string | null;
  qty: number;
}

/**
 * Промежуточный итог позиций в копейках (ТОЛЬКО для предпросмотра в UI).
 * Использует ту же effectiveUnitPriceMinor, что и серверный расчёт, но это НЕ
 * влияет на итог заказа — сервер считает заново (ADR-010).
 */
export function estimateItemsTotalMinor(lines: EstimateLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.qty <= 0) continue;
    const unit = effectiveUnitPriceMinor({
      basePrice: line.basePrice,
      priceOverride: line.priceOverride ?? null,
      priceDelta: line.priceDelta ?? null,
    });
    total += unit * line.qty;
  }
  return total;
}

/** Промежуточный итог как строка-сумма (для formatPrice в UI). */
export function estimateItemsTotal(lines: EstimateLine[]): string {
  return fromMinor(estimateItemsTotalMinor(lines));
}
