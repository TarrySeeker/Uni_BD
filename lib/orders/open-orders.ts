import type { TransactionSql } from 'postgres';

import { OPEN_ORDER_STATUSES } from './status';

/**
 * Поиск НЕЗАКРЫТЫХ заказов, которые ссылаются на позицию каталога
 * (аудит 2026-07-26, находка #9).
 *
 * Зачем модуль orders экспортирует это каталогу: FK `inventory.variant_id ...
 * ON DELETE CASCADE` (0010) и `order_items.variant_id ... ON DELETE SET NULL`
 * (0012) вместе дают тихую потерю резерва — удалили вариант, строка остатка
 * исчезла, а заказ на него остался. Дальше переход в «Отгружен» вызывает
 * commitReservation, тот не находит строку и ВСЕГДА возвращает false → заказ
 * навсегда застревает в «Собран». Схему трогать не нужно: достаточно не давать
 * удалять то, что ещё кому-то отгружается.
 *
 * Возвращаются НОМЕРА заказов (а не id) — они уходят прямо в текст отказа, чтобы
 * владелец сразу видел, что именно мешает удалению.
 *
 * ВЫЗЫВАТЬ В ТРАНЗАКЦИИ, ПОСЛЕ блокировки соответствующих строк inventory
 * (SELECT ... FOR UPDATE): резерв берётся UPDATE-ом той же строки внутри
 * createOrder, поэтому блокировка сериализует нас с параллельным оформлением
 * заказа, а этот запрос лишь дочитывает картину.
 */

/** Сколько номеров заказов показывать в сообщении об отказе. */
const MAX_REPORTED_ORDERS = 5;

/** Незакрытые заказы, содержащие указанный ВАРИАНТ товара. */
export async function findOpenOrderNumbersForVariant(
  tx: TransactionSql,
  variantId: string,
): Promise<string[]> {
  const rows = await tx<{ number: string }[]>`
    SELECT DISTINCT o.number
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.variant_id = ${variantId}
       AND o.status = ANY(${OPEN_ORDER_STATUSES as unknown as string[]})
     ORDER BY o.number
     LIMIT ${MAX_REPORTED_ORDERS}
  `;
  return rows.map((r) => r.number);
}

/** Незакрытые заказы, содержащие указанный ТОВАР (любой его вариант). */
export async function findOpenOrderNumbersForProduct(
  tx: TransactionSql,
  productId: string,
): Promise<string[]> {
  const rows = await tx<{ number: string }[]>`
    SELECT DISTINCT o.number
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = ${productId}
       AND o.status = ANY(${OPEN_ORDER_STATUSES as unknown as string[]})
     ORDER BY o.number
     LIMIT ${MAX_REPORTED_ORDERS}
  `;
  return rows.map((r) => r.number);
}
