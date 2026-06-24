/**
 * StatusMap — ЧИСТЫЙ маппинг кодов статусов СДЭК → delivery_status заказа Admik
 * (docs/08 §2.4, порт carre common/components/Cdek/StatusMap.php).
 *
 * Без сети, без БД, без зависимости от manager — только статические таблицы и
 * чистые функции. Поэтому покрыт полной матрицей тестов и всегда зелёный.
 *
 * Двухступенчатый маппинг (как carre):
 *   1) код СДЭК → категория carre (0–5)  [STATUS_TO_CATEGORY];
 *   2) категория → DeliveryStatus Admik   [categoryToDeliveryStatus].
 *
 * Категории 1/2/3 коллапсируют в registered/in_transit, потому что статус-машина
 * Admik (lib/orders/status.ts) грубее: registered → in_transit → delivered/
 * returned. Переход применяет вызывающий (WebhookService, пакет D) через
 * canTransitionDelivery — здесь только чистый маппинг «куда должны прийти».
 */

import type { DeliveryStatus } from '@/lib/orders/types';

// -----------------------------------------------------------------------------
// Таблицы (порт StatusMap.php дословно).
// -----------------------------------------------------------------------------

/**
 * Код статуса СДЭК → категория carre (0–5):
 *   0 = создан, без накладной (дефолт неизвестных)
 *   1 = накладная создана, ожидает приёмки
 *   2 = в пути
 *   3 = прибыл в город/ПВЗ
 *   4 = вручён (терминальный успех)
 *   5 = проблема/возврат/отмена (терминальный)
 */
export const STATUS_TO_CATEGORY: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5>> = {
  CREATED: 1,
  ACCEPTED: 1,
  RECEIVED_AT_SHIPMENT_WAREHOUSE: 2,
  READY_TO_SHIP_AT_SENDING_OFFICE: 2,
  TAKEN_BY_TRANSPORTER_FROM_SENDER_CITY: 2,
  SENT_TO_TRANSIT_CITY: 2,
  ACCEPTED_IN_TRANSIT_CITY: 2,
  ACCEPTED_AT_TRANSIT_WAREHOUSE: 2,
  RETURNED_TO_TRANSIT_WAREHOUSE: 2,
  READY_TO_SHIP_IN_TRANSIT_OFFICE: 2,
  TAKEN_BY_TRANSPORTER_FROM_TRANSIT_CITY: 2,
  SENT_TO_SENDER_CITY: 2,
  SENT_TO_RECIPIENT_CITY: 2,
  ON_THE_WAY: 2,
  ACCEPTED_IN_RECIPIENT_CITY: 3,
  ACCEPTED_AT_PICK_UP_POINT: 3,
  TAKEN_BY_COURIER: 3,
  RETURNED_TO_RECIPIENT_CITY_WAREHOUSE: 3,
  READY_FOR_PICKUP: 3,
  DELIVERED: 4,
  NOT_DELIVERED: 5,
  RETURNED_TO_SENDER: 5,
  RETURNED_TO_SENDER_ACCEPTED: 5,
  RETURNED_TO_SENDER_CITY_WAREHOUSE: 5,
  CANCELLED: 5,
  INVALID: 5,
  LOST: 5,
};

/** Русские человекочитаемые имена статусов (порт STATUS_TO_NAME). */
export const STATUS_TO_NAME: Readonly<Record<string, string>> = {
  CREATED: 'Заказ создан',
  ACCEPTED: 'Принят на склад отправителя',
  RECEIVED_AT_SHIPMENT_WAREHOUSE: 'Принят на склад отправителя',
  READY_TO_SHIP_AT_SENDING_OFFICE: 'Готов к отправке в городе отправителе',
  TAKEN_BY_TRANSPORTER_FROM_SENDER_CITY: 'Передан перевозчику в городе-отправителе',
  SENT_TO_TRANSIT_CITY: 'Отправлен в город-транзит',
  ACCEPTED_IN_TRANSIT_CITY: 'Принят в городе-транзит',
  ACCEPTED_AT_TRANSIT_WAREHOUSE: 'Принят на склад транзита',
  RETURNED_TO_TRANSIT_WAREHOUSE: 'Возвращён на склад транзита',
  READY_TO_SHIP_IN_TRANSIT_OFFICE: 'Готов к отправке в транзите',
  TAKEN_BY_TRANSPORTER_FROM_TRANSIT_CITY: 'Передан перевозчику в транзите',
  SENT_TO_SENDER_CITY: 'Отправлен в город-отправитель',
  SENT_TO_RECIPIENT_CITY: 'Отправлен в город-получатель',
  ACCEPTED_IN_RECIPIENT_CITY: 'Принят в городе-получателе',
  ACCEPTED_AT_PICK_UP_POINT: 'Принят на склад доставки',
  TAKEN_BY_COURIER: 'Передан курьеру',
  RETURNED_TO_RECIPIENT_CITY_WAREHOUSE: 'Возвращён на склад доставки',
  READY_FOR_PICKUP: 'Готов к выдаче',
  ON_THE_WAY: 'В пути',
  DELIVERED: 'Вручён',
  NOT_DELIVERED: 'Не доставлен',
  RETURNED_TO_SENDER: 'Возврат отправителю',
  RETURNED_TO_SENDER_ACCEPTED: 'Возврат принят отправителем',
  RETURNED_TO_SENDER_CITY_WAREHOUSE: 'Возврат на складе города-отправителя',
  CANCELLED: 'Отменён',
  INVALID: 'Недействителен',
  LOST: 'Утерян',
};

/**
 * Код → шаблон клиентского письма (порт STATUS_TO_TEMPLATE). null = без письма.
 * CREATED намеренно отсутствует — технический статус.
 */
export const STATUS_TO_CLIENT_TEMPLATE: Readonly<Record<string, string>> = {
  RECEIVED_AT_SHIPMENT_WAREHOUSE: 'cdek_accepted',
  ACCEPTED_IN_RECIPIENT_CITY: 'cdek_in_transit',
  SENT_TO_RECIPIENT_CITY: 'cdek_in_transit',
  ACCEPTED_AT_PICK_UP_POINT: 'cdek_ready_for_pickup',
  READY_FOR_PICKUP: 'cdek_ready_for_pickup',
  TAKEN_BY_COURIER: 'cdek_courier_dispatched',
  DELIVERED: 'cdek_delivered',
};

/** Код → шаблон админ-письма о проблеме (порт STATUS_TO_ADMIN_TEMPLATE). */
export const STATUS_TO_ADMIN_TEMPLATE: Readonly<Record<string, string>> = {
  NOT_DELIVERED: 'cdek_problem',
  RETURNED_TO_SENDER: 'cdek_problem',
  RETURNED_TO_SENDER_ACCEPTED: 'cdek_problem',
  RETURNED_TO_SENDER_CITY_WAREHOUSE: 'cdek_problem',
  CANCELLED: 'cdek_problem',
  LOST: 'cdek_problem',
  INVALID: 'cdek_problem',
};

// -----------------------------------------------------------------------------
// Чистые функции маппинга.
// -----------------------------------------------------------------------------

/** Код СДЭК → категория carre (0–5). Неизвестный → 0. */
export function categorize(code: string): 0 | 1 | 2 | 3 | 4 | 5 {
  return STATUS_TO_CATEGORY[code] ?? 0;
}

/**
 * Категория carre (0–5) → DeliveryStatus Admik.
 *   0 → null (без накладной — нечего применять)
 *   1 → registered; 2/3 → in_transit; 4 → delivered; 5 → returned (дефолт проблемы)
 *
 * Внимание: категория 5 включает и отмену (CANCELLED → cancelled). Поэтому для
 * точного маппинга используйте mapCdekStatus(code), который различает отмену по
 * коду; categoryToDeliveryStatus(5) даёт «проблема/возврат» = returned.
 */
export function categoryToDeliveryStatus(category: number): DeliveryStatus | null {
  switch (category) {
    case 1:
      return 'registered';
    case 2:
    case 3:
      return 'in_transit';
    case 4:
      return 'delivered';
    case 5:
      return 'returned';
    case 0:
    default:
      return null;
  }
}

/**
 * Главная функция: код статуса СДЭК → DeliveryStatus заказа Admik.
 * Неизвестный код / категория 0 → null (вызывающий пропускает переход).
 *
 * Особый случай категории 5: CANCELLED → 'cancelled', остальные (проблема/
 * возврат/утеря/недействителен) → 'returned'.
 */
export function mapCdekStatus(code: string): DeliveryStatus | null {
  if (!code) return null;
  if (code === 'CANCELLED') return 'cancelled';
  return categoryToDeliveryStatus(categorize(code));
}

/** Русское имя статуса; для неизвестного кода — сам код. */
export function displayName(code: string): string {
  return STATUS_TO_NAME[code] ?? code;
}

/** Шаблон клиентского письма для кода или null. */
export function clientEmailTemplate(code: string): string | null {
  return STATUS_TO_CLIENT_TEMPLATE[code] ?? null;
}

/** Шаблон админ-письма (проблема) для кода или null. */
export function adminEmailTemplate(code: string): string | null {
  return STATUS_TO_ADMIN_TEMPLATE[code] ?? null;
}

/**
 * Объект-фасад StatusMap (совместимость с контрактом docs/08 §2.4).
 * Дублирует чистые функции выше для потребителей, ожидающих namespace-API.
 */
export const StatusMap = {
  categorize,
  categoryToDeliveryStatus,
  toDeliveryStatus: mapCdekStatus,
  displayName,
  clientEmailTemplate,
  adminEmailTemplate,
} as const;
