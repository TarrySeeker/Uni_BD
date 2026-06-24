import { afterAll, describe, it, expect } from 'vitest';
import { mapShipment, mapStatusLog } from '@/lib/cdek/repository';

/**
 * Тесты репозитория СДЭК (docs/08 §2 «repository.ts»).
 *
 * (а) ЮНИТ — мапперы row→domain (snake_case → camelCase, типы/null). Без БД.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — CRUD cdek_shipments и идемпотентная
 *     запись cdek_status_log (insertStatusLog: inserted true/false).
 */

// =============================================================================
// (а) ЮНИТ — мапперы. Всегда зелёные.
// =============================================================================
describe('cdek/repository — мапперы row→domain (юнит)', () => {
  it('mapShipment: snake_case → camelCase, числа/null/булевы', () => {
    const now = new Date('2026-06-15T10:00:00Z');
    const sh = mapShipment({
      id: 'sh-1',
      order_id: 'ord-1',
      cdek_uuid: 'uuid-1',
      cdek_number: '1012345678',
      tariff_code: '136',
      pvz_code: 'MSK1',
      city_code: '44',
      delivery_mode: 'pvz',
      weight_g: '500',
      length_cm: '30',
      width_cm: '20',
      height_cm: '10',
      delivery_sum: '350.00',
      status_code: 'CREATED',
      status_name: 'Создан',
      status_at: now,
      print_url: null,
      is_mock: true,
      error: null,
      retry_count: '2',
      created_at: now,
      updated_at: now,
    });
    expect(sh.id).toBe('sh-1');
    expect(sh.orderId).toBe('ord-1');
    expect(sh.cdekUuid).toBe('uuid-1');
    expect(sh.tariffCode).toBe(136);
    expect(sh.cityCode).toBe(44);
    expect(sh.deliveryMode).toBe('pvz');
    expect(sh.weightG).toBe(500);
    expect(sh.deliverySum).toBe('350.00'); // деньги — строка
    expect(sh.isMock).toBe(true);
    expect(sh.printUrl).toBeNull();
    expect(sh.retryCount).toBe(2);
    expect(sh.statusAt).toBeInstanceOf(Date);
  });

  it('mapShipment: пустое отправление (до создания) — все опц. поля null', () => {
    const now = new Date();
    const sh = mapShipment({
      id: 'sh-2',
      order_id: 'ord-2',
      cdek_uuid: null,
      cdek_number: null,
      tariff_code: null,
      pvz_code: null,
      city_code: null,
      delivery_mode: null,
      weight_g: null,
      length_cm: null,
      width_cm: null,
      height_cm: null,
      delivery_sum: null,
      status_code: null,
      status_name: null,
      status_at: null,
      print_url: null,
      is_mock: false,
      error: null,
      retry_count: 0,
      created_at: now,
      updated_at: now,
    });
    expect(sh.cdekUuid).toBeNull();
    expect(sh.tariffCode).toBeNull();
    expect(sh.statusAt).toBeNull();
    expect(sh.deliverySum).toBeNull();
    expect(sh.retryCount).toBe(0);
    expect(sh.isMock).toBe(false);
  });

  it('mapStatusLog: raw_payload как объект и как строка JSON', () => {
    const now = new Date();
    const fromObj = mapStatusLog({
      id: 'log-1',
      order_id: 'ord-1',
      cdek_uuid: 'uuid-1',
      status_code: 'DELIVERED',
      status_name: 'Вручён',
      status_date_time: now,
      city_code: '44',
      city_name: 'Москва',
      is_mock: false,
      raw_payload: { type: 'ORDER_STATUS' },
      processed: true,
      ip: '212.69.96.10',
      received_at: now,
    });
    expect(fromObj.statusCode).toBe('DELIVERED');
    expect(fromObj.rawPayload).toEqual({ type: 'ORDER_STATUS' });
    expect(fromObj.processed).toBe(true);
    expect(fromObj.ip).toBe('212.69.96.10');
    expect(fromObj.cityCode).toBe(44);

    const fromStr = mapStatusLog({
      id: 'log-2',
      order_id: 'ord-1',
      cdek_uuid: 'uuid-1',
      status_code: 'CREATED',
      status_name: null,
      status_date_time: null,
      city_code: null,
      city_name: null,
      is_mock: true,
      raw_payload: '{"a":1}',
      processed: false,
      ip: null,
      received_at: now,
    });
    expect(fromStr.rawPayload).toEqual({ a: 1 });
    expect(fromStr.statusDateTime).toBeNull();
    expect(fromStr.isMock).toBe(true);
  });

  it('mapStatusLog: битый JSON в raw_payload → null (без падения)', () => {
    const entry = mapStatusLog({
      id: 'log-3',
      order_id: 'ord-1',
      cdek_uuid: 'uuid-1',
      status_code: 'CREATED',
      raw_payload: 'не-json{',
      processed: false,
      is_mock: false,
      received_at: new Date(),
    });
    expect(entry.rawPayload).toBeNull();
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — нужна живая БД. PostgreSQL нет → skipIf.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('cdek/repository — CRUD (интеграция)', () => {
  let repo: typeof import('@/lib/cdek/repository');
  let sql: any;

  async function ensureLoaded(): Promise<void> {
    if (!repo) repo = await import('@/lib/cdek/repository');
    if (!sql) {
      const postgres = (await import('postgres')).default;
      sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    }
  }

  async function makeOrder(): Promise<string> {
    const [order] = await sql`
      INSERT INTO orders (number, items_total, grand_total, customer_name, customer_email, customer_phone)
      VALUES (${'CDEK-REPO-' + Date.now() + '-' + Math.random()}, 100, 100, 'T', 'r@example.com', '+70000000000')
      RETURNING id`;
    return order.id as string;
  }

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('createShipment → getShipmentByOrderId/getShipmentByCdekUuid', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    const created = await repo.createShipment({
      orderId,
      cdekUuid: 'uuid-' + Date.now(),
      tariffCode: 136,
      deliveryMode: 'pvz',
      weightG: 500,
      deliverySum: '350.00',
      isMock: true,
    });
    expect(created.orderId).toBe(orderId);
    expect(created.tariffCode).toBe(136);

    const byOrder = await repo.getShipmentByOrderId(orderId);
    expect(byOrder?.id).toBe(created.id);
    const byUuid = await repo.getShipmentByCdekUuid(created.cdekUuid!);
    expect(byUuid?.id).toBe(created.id);

    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  it('updateShipmentByOrderId: COALESCE-патч не затирает существующее', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    await repo.createShipment({ orderId, tariffCode: 136, isMock: true });
    const updated = await repo.updateShipmentByOrderId(orderId, {
      cdekNumber: '1099999999',
      statusCode: 'CREATED',
    });
    expect(updated?.cdekNumber).toBe('1099999999');
    expect(updated?.tariffCode).toBe(136); // не затёрто null-полем
    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  // БАГ B волны 7: первый create накладной упал (error='...', retry_count>0,
  // cdek_uuid=NULL); повторный create успешен (uuid выставлен). На успехе должен
  // явно сброситься error и retry_count — COALESCE(error) при error=null оставил
  // бы старый текст, и оператор видел бы «ошибку» на успешной накладной.
  it('updateShipmentByOrderId: clearError=true сбрасывает error и retry_count при успехе', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    // Состояние после неудачного create.
    await repo.createShipment({ orderId, error: 'Сбой связи с API СДЭК', isMock: true });
    await repo.bumpShipmentRetry(orderId, 'Сбой связи с API СДЭК');
    const failed = await repo.getShipmentByOrderId(orderId);
    expect(failed?.error).toBe('Сбой связи с API СДЭК');
    expect(failed?.retryCount).toBe(1);
    expect(failed?.cdekUuid).toBeNull();

    // Успешное пере-создание: выставляем uuid и явно чистим ошибку/счётчик.
    const ok = await repo.updateShipmentByOrderId(orderId, {
      cdekUuid: 'uuid-ok-' + Date.now(),
      clearError: true,
    });
    expect(ok?.cdekUuid).not.toBeNull();
    expect(ok?.error).toBeNull();
    expect(ok?.retryCount).toBe(0);

    const reread = await repo.getShipmentByOrderId(orderId);
    expect(reread?.error).toBeNull();
    expect(reread?.cdekUuid).not.toBeNull();
    expect(reread?.retryCount).toBe(0);

    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  // Регресс к существующему поведению: БЕЗ clearError патч НЕ трогает error (даже
  // когда error не передан) и НЕ трогает retry_count — COALESCE сохраняет прежнее.
  it('updateShipmentByOrderId: без clearError старая ошибка и retry_count сохраняются', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    await repo.createShipment({ orderId, error: 'Прошлая ошибка', isMock: true });
    await repo.bumpShipmentRetry(orderId, 'Прошлая ошибка');
    const updated = await repo.updateShipmentByOrderId(orderId, { statusCode: 'CREATED' });
    expect(updated?.statusCode).toBe('CREATED');
    expect(updated?.error).toBe('Прошлая ошибка'); // COALESCE не затёр
    expect(updated?.retryCount).toBe(1); // не сброшен
    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  it('insertStatusLog: первый раз inserted=true, повтор inserted=false', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    const cdekUuid = 'uuid-idem-' + Date.now();
    const dt = new Date('2026-06-15T12:00:00Z');
    const first = await repo.insertStatusLog({
      orderId,
      cdekUuid,
      statusCode: 'DELIVERED',
      statusDateTime: dt,
      rawPayload: { x: 1 },
    });
    expect(first.inserted).toBe(true);
    expect(first.entry?.statusCode).toBe('DELIVERED');

    const dup = await repo.insertStatusLog({
      orderId,
      cdekUuid,
      statusCode: 'DELIVERED',
      statusDateTime: dt,
    });
    expect(dup.inserted).toBe(false);
    expect(dup.entry).toBeNull();

    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  it('insertStatusLog: события без статус-времени тоже идемпотентны (to_timestamp(0))', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    const cdekUuid = 'uuid-nodt-' + Date.now();
    const a = await repo.insertStatusLog({ orderId, cdekUuid, statusCode: 'CREATED' });
    const b = await repo.insertStatusLog({ orderId, cdekUuid, statusCode: 'CREATED' });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });

  it('markStatusLogProcessed помечает обработанным', async () => {
    await ensureLoaded();
    const orderId = await makeOrder();
    const res = await repo.insertStatusLog({
      orderId,
      cdekUuid: 'uuid-proc-' + Date.now(),
      statusCode: 'ON_THE_WAY',
    });
    await repo.markStatusLogProcessed(res.entry!.id);
    const list = await repo.listStatusLogByOrderId(orderId);
    expect(list[0]?.processed).toBe(true);
    await sql`DELETE FROM orders WHERE id = ${orderId}`;
  });
});
