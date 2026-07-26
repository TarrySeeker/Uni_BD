/**
 * Чистая логика страницы заказа витрины: «где моя посылка» и ссылка «вернуться
 * к заказу» (находка аудита №5).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Тестов React-компонентов в проекте нет (vitest
 * environment 'node'), поэтому всё вычислимое живёт здесь и покрывается
 * вызовами, а на вёрстку остаётся guard-тест по исходнику.
 *
 * 🔴 ГЛАВНОЕ ПРАВИЛО. Подпись статуса доставки берётся ПО МАШИННОМУ КОДУ из
 * словаря витрины, а НЕ из серверного `deliveryStatusLabel` — тот приходит с
 * сервера всегда по-русски (lib/orders/labels.ts), и рендер серверной подписи
 * закрепил бы русский статус для англо- и франкоязычного покупателя. Серверная
 * подпись остаётся лишь фолбэком для кода, которого витрина ещё не знает.
 */

import type { Dictionary } from './dictionaries';
import { localizedHref, type Locale } from './i18n';
import type { OrderPublicDto } from './types';

/** Подсекция словаря страницы заказа. */
export type OrderDict = Dictionary['order'];

/** Блок доставки публичного DTO (address/pvzCode опциональны — version skew). */
export type OrderDelivery = OrderPublicDto['delivery'];

// ---------------------------------------------------------------------------
// Алфавиты (зеркало домена: lib/orders/types.ts DELIVERY_STATUSES/DELIVERY_TYPES).
// Расхождение ловится tests/storefront-ui/order-tracking.guard.test.ts.
// ---------------------------------------------------------------------------

/** Коды статуса доставки — OrderPublicDto.deliveryStatus. */
export const DELIVERY_STATUS_CODES = [
  'pending',
  'registered',
  'in_transit',
  'delivered',
  'returned',
  'cancelled',
] as const;

/** Коды способа доставки — OrderPublicDto.delivery.type. */
export const DELIVERY_METHOD_CODES = ['courier', 'pvz', 'pickup'] as const;

export type DeliveryStatusCode = (typeof DELIVERY_STATUS_CODES)[number];
export type DeliveryMethodCode = (typeof DELIVERY_METHOD_CODES)[number];

// ---------------------------------------------------------------------------
// Подписи.
// ---------------------------------------------------------------------------

/**
 * Подпись статуса доставки для покупателя. Порядок источников:
 *   1) словарь витрины по коду (локализовано — единственный правильный путь);
 *   2) серверная подпись (незнакомый витрине код: сервер новее — лучше русская
 *      осмысленная строка, чем сырой машинный код);
 *   3) нейтральная строка словаря (кода не знает никто).
 * Сырой код покупателю не показывается никогда.
 */
export function deliveryStatusText(
  order: { deliveryStatus: string; deliveryStatusLabel?: string | null },
  t: OrderDict,
): string {
  const byCode: Record<DeliveryStatusCode, string> = {
    pending: t.deliveryStatusPending,
    registered: t.deliveryStatusRegistered,
    in_transit: t.deliveryStatusInTransit,
    delivered: t.deliveryStatusDelivered,
    returned: t.deliveryStatusReturned,
    cancelled: t.deliveryStatusCancelled,
  };
  const known = (byCode as Record<string, string | undefined>)[order.deliveryStatus];
  if (known) return known;
  const fromServer = order.deliveryStatusLabel?.trim();
  return fromServer && fromServer.length > 0 ? fromServer : t.deliveryStatusUnknown;
}

/**
 * Подпись способа доставки. Постамат — подвид ПВЗ (флаг поверх type='pvz'),
 * поэтому у него своя подпись. Незнакомый код → нейтральная строка словаря.
 */
export function deliveryMethodText(delivery: OrderDelivery, t: OrderDict): string {
  if (delivery.type === 'pvz') {
    return delivery.isPostamat ? t.methodPostamat : t.methodPvz;
  }
  const byCode: Record<string, string> = {
    courier: t.methodCourier,
    pickup: t.methodPickup,
  };
  return byCode[delivery.type] ?? t.methodUnknown;
}

/** Непустая строка после trim, иначе null. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Куда едет посылка: город + адрес (курьер) либо город + код пункта выдачи
 * (ПВЗ/постамат). Пустые и отсутствующие части опускаются, дубли схлопываются.
 * null — показывать нечего (блок не рисуем, пустых строк покупателю не даём).
 *
 * Толерантна к старому серверу без полей address/pvzCode.
 */
export function deliveryPlaceText(delivery: OrderDelivery): string | null {
  const detail =
    delivery.type === 'courier' ? clean(delivery.address) : clean(delivery.pvzCode);
  const parts: string[] = [];
  for (const part of [clean(delivery.city), detail]) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Есть ли что показать в блоке доставки (иначе секцию не рисуем). */
export function hasDeliveryDetails(delivery: OrderDelivery): boolean {
  return Boolean(clean(delivery.track)) || deliveryPlaceText(delivery) !== null;
}

// ---------------------------------------------------------------------------
// Постоянная ссылка на заказ (номер + токен — тот же периметр, что у кодов
// подарочного сертификата: перебрать номер без токена невозможно).
// ---------------------------------------------------------------------------

/**
 * Путь постоянной страницы заказа. Локализован (ru — корень без префикса).
 * Номер и токен экранируются: номер магазина мультитенантен и может содержать
 * что угодно, кроме гарантий.
 */
export function orderTrackingPath(
  number: string,
  token: string,
  locale: Locale,
): string {
  const query = `number=${encodeURIComponent(number)}&token=${encodeURIComponent(token)}`;
  return `${localizedHref('/order', locale)}?${query}`;
}

/**
 * Разбор параметров ссылки на заказ. Пара валидна ТОЛЬКО когда есть и номер, и
 * непустой токен: доступ по одному номеру означал бы перебор чужих заказов.
 */
export function readOrderLink(
  params: { number?: string; token?: string } | undefined | null,
): { number: string; token: string } | null {
  const number = clean(params?.number);
  const token = clean(params?.token);
  return number && token ? { number, token } : null;
}
