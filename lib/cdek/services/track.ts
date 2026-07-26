/**
 * Трек-номер СДЭК: разбор из источников и сохранение (находка аудита №25).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. Номер отправления (`cdek_number`) приходит В ТРЁХ
 * разных местах и НИ В ОДНОМ не сохранялся:
 *   • создание накладной (order.ts) — боевой СДЭК на POST /v2/orders отдаёт
 *     ТОЛЬКО uuid, номер присваивается асинхронно, поэтому там пишется null;
 *   • webhook (webhook.ts) — `attributes.cdek_number` разбирался в CdekEvent и
 *     молча ВЫБРАСЫВАЛСЯ;
 *   • pull-трекинг (tracking.ts) — `entity.cdek_number` не читался вовсе,
 *     обновлялся только статус.
 * Итог: `orders.cdek_track` в боевом режиме оставался NULL НАВСЕГДА, и покупателю
 * (order-dto → delivery.track) показывать было нечего.
 *
 * Здесь один вход для сохранения — идемпотентный и безопасный: пустое значение
 * НИКОГДА не затирает уже сохранённый номер (события СДЭК приходят и без него).
 *
 * Чистые функции (normalize/parse) тестируются без сети и БД.
 */

import { sql } from '@/lib/db/client';

/**
 * Нормализует трек-номер: непустая строка → trim, всё остальное → null.
 * null означает «номера нет» — не путать с «номер пустой» (см. saveTrackNumber:
 * null не затирает сохранённое).
 */
export function normalizeTrackNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Трек-номер из ответа СДЭК GET /v2/orders/{uuid} (`entity.cdek_number`).
 * Толерантна к форме: принимает и camelCase-вариант, мусор → null.
 */
export function trackFromTrackingResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const entity = (raw as { entity?: unknown }).entity;
  if (!entity || typeof entity !== 'object') return null;
  const e = entity as Record<string, unknown>;
  return normalizeTrackNumber(e.cdek_number) ?? normalizeTrackNumber(e.cdekNumber);
}

/**
 * Сохраняет трек-номер заказа: `cdek_shipments.cdek_number` (источник истины
 * модуля) + денормализованный `orders.cdek_track` (горячее поле для списков
 * админки и публичного DTO витрины).
 *
 * Идемпотентно и безопасно:
 *   • пустой/отсутствующий номер → no-op (НЕ затираем ранее сохранённый);
 *   • номер не изменился → UPDATE не выполняется (IS DISTINCT FROM), лишних
 *     записей в WAL и бампов updated_at нет;
 *   • строки отправления может ещё не быть — заказ обновится в любом случае.
 *
 * @returns true, если значение в БД реально изменилось.
 */
export async function saveTrackNumber(
  orderId: string,
  value: unknown,
): Promise<boolean> {
  const track = normalizeTrackNumber(value);
  if (!track) return false;

  await sql`
    UPDATE cdek_shipments
       SET cdek_number = ${track},
           updated_at  = now()
     WHERE order_id = ${orderId}
       AND cdek_number IS DISTINCT FROM ${track}
  `;

  const changed = await sql<{ id: string }[]>`
    UPDATE orders
       SET cdek_track = ${track},
           updated_at = now()
     WHERE id = ${orderId}
       AND cdek_track IS DISTINCT FROM ${track}
    RETURNING id
  `;

  return changed.length > 0;
}
