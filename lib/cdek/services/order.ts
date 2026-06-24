/**
 * OrderService — создание/отмена отправления СДЭК (docs/08 §7.1, порт carre
 * OrderService.php).
 *
 * Выбор источника — по manager.isMock (docs/08 §11):
 *   • mock → mockCreateShipment (фейковый uuid+трек), без сети;
 *   • real → manager.client.request POST /v2/orders.
 *
 * Идемпотентность (docs/08 §7.1): если отправление по заказу уже создано
 * (cdek_uuid выставлен) — повторно не создаём, возвращаем существующее (если не
 * передан force). Самовывоз (pickup) пропускается. Состояние заказа проверяется:
 * заказ должен быть оплачен (paymentStatus === 'paid' или status уже не new/
 * awaiting_payment) — иначе ошибка precondition.
 *
 * Чистые/тестируемые части: normalizePhone, buildPayload — без сети/БД.
 * БД-зависимые createShipment/cancelShipment — интеграционные (skipIf в тестах).
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import type { CdekManager } from '../manager';
import { getCdekManager } from '../manager';
import { CdekError } from '../errors';
import {
  getShipmentByOrderId,
  createShipment as repoCreateShipment,
  updateShipmentByOrderId,
  bumpShipmentRetry,
} from '../repository';
import { getOrderById, type OrderWithItems } from '@/lib/orders/repository';
import { tariffForMode } from '../config';
import { canTransitionDelivery } from '@/lib/orders/status';
import type { Order, OrderItem } from '@/lib/orders/types';
import type {
  CdekShipment,
  CdekDeliveryMode,
  CdekPackage,
} from '../types';
import { aggregatePackage, type CartLineDims } from './calculator';

// -----------------------------------------------------------------------------
// normalizePhone — ЧИСТАЯ (порт OrderService::normalizePhone). Тестируется без сети.
// -----------------------------------------------------------------------------

/**
 * Нормализует телефон в формат +7XXXXXXXXXX (порт carre):
 *   • только цифры;
 *   • 10 цифр → префикс +7;
 *   • 11 цифр, начинается с 8 или 7 → ведущая заменяется на 7, префикс +;
 *   • иначе (< 10 / непонятный формат) → CdekError.
 */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D+/g, '');
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) {
    return `+7${digits.slice(1)}`;
  }
  throw new CdekError('cdek_invalid_phone', `Некорректный телефон получателя: "${raw}".`);
}

// -----------------------------------------------------------------------------
// Снимок отправления из заказа (вес/габариты/режим/назначение).
// -----------------------------------------------------------------------------

/** delivery_type заказа → режим доставки СДЭК. */
export function deliveryModeFor(order: Order): CdekDeliveryMode {
  switch (order.deliveryType) {
    case 'courier':
      return 'door';
    case 'pvz':
      return 'pvz';
    default:
      // pickup сюда не доходит (отсекается раньше), но для полноты — door.
      return 'door';
  }
}

/**
 * Позиции заказа → строки для агрегации упаковки. Вес/габариты берутся из СНИМКА
 * заказа (order_items, 0026), который при createOrder резолвится приоритетом
 * вариант→товар из каталога (resolveLineDims). NULL-поля → дефолт магазина
 * (CDEK_DEFAULT_*) подставит aggregatePackage. Так СДЭК использует РЕАЛЬНЫЕ
 * габариты позиции, а не только дефолт.
 */
function linesFromItems(items: readonly OrderItem[]): CartLineDims[] {
  return items.map((it) => ({
    qty: it.quantity,
    weightG: it.weightG ?? null,
    lengthCm: it.lengthCm ?? null,
    widthCm: it.widthCm ?? null,
    heightCm: it.heightCm ?? null,
  }));
}

/**
 * Вес ОДНОЙ единицы позиции для item-уровня payload СДЭК (граммы, ≥ 1).
 * Приоритет: снимок позиции (вес единицы) → дефолт магазина. Целое (округление).
 */
function itemUnitWeight(item: OrderItem, defaultWeightG: number): number {
  const w = item.weightG ?? defaultWeightG;
  return Math.max(1, Math.round(w));
}

// -----------------------------------------------------------------------------
// buildPayload — ЧИСТАЯ (порт OrderService::buildPayload). Тестируется без сети.
// -----------------------------------------------------------------------------

/** Тело запроса POST /v2/orders (snake_case как у СДЭК). */
export interface CdekOrderPayload {
  type: number;
  number: string;
  tariff_code: number;
  shipment_point?: string;
  from_location?: { code: number };
  delivery_point?: string;
  to_location?: { code?: number; postal_code?: string; address?: string };
  recipient: {
    name: string;
    phones: Array<{ number: string }>;
    email?: string;
  };
  sender?: {
    name?: string;
    company?: string;
    email?: string;
    tin?: string;
    phones?: Array<{ number: string }>;
  };
  packages: Array<{
    number: string;
    weight: number;
    length?: number;
    width?: number;
    height?: number;
    items: Array<{
      name: string;
      ware_key: string;
      payment: { value: number };
      cost: number;
      amount: number;
      weight: number;
    }>;
  }>;
}

/** Опции сборки payload (габариты по умолчанию из конфига). */
export interface BuildPayloadOptions {
  defaultDimensions: { weightG: number; lengthCm: number; widthCm: number; heightCm: number };
  fromLocationCode: number;
  shipmentPoint: string | null;
  /** Тариф ПВЗ/постамата (склад-склад, 136). */
  defaultTariffCode: number;
  /** Тариф курьера «до двери» (склад-дверь, 137) — выбирается для mode==='door'. */
  doorTariffCode: number;
  sender: {
    name: string | null;
    contactName: string | null;
    phone: string | null;
    email: string | null;
    inn: string | null;
  };
}

/**
 * Собирает payload создания отправления из заказа+позиций (порт buildPayload).
 * Чистая: вход — заказ/позиции/опции; никакого I/O.
 *
 * Назначение: режим pvz/postamat → delivery_point (код ПВЗ); door → to_location
 * (код города + индекс/адрес). Отправитель: shipment_point ИЛИ from_location
 * (взаимоисключимы). packages — одна упаковка, агрегированная из позиций.
 */
export function buildPayload(
  order: Order,
  items: readonly OrderItem[],
  opts: BuildPayloadOptions,
): CdekOrderPayload {
  const mode = deliveryModeFor(order);
  const pkg: CdekPackage = aggregatePackage(linesFromItems(items), {
    weightG: opts.defaultDimensions.weightG,
    lengthCm: opts.defaultDimensions.lengthCm,
    widthCm: opts.defaultDimensions.widthCm,
    heightCm: opts.defaultDimensions.heightCm,
  });

  // Тариф по режиму (M4): курьер (door) → doorTariffCode (склад-дверь), иначе
  // ПВЗ/постамат → defaultTariffCode (склад-склад). Раньше всегда defaultTariffCode
  // → курьер уходил с ПВЗ-тарифом.
  const tariffCode = mode === 'door' ? opts.doorTariffCode : opts.defaultTariffCode;

  const payload: CdekOrderPayload = {
    type: 1,
    number: order.number,
    tariff_code: tariffCode,
    recipient: {
      name: order.customerName,
      phones: [{ number: normalizePhone(order.customerPhone) }],
      ...(order.customerEmail ? { email: order.customerEmail } : {}),
    },
    sender: {
      ...(opts.sender.name ? { company: opts.sender.name } : {}),
      ...(opts.sender.contactName ? { name: opts.sender.contactName } : {}),
      ...(opts.sender.email ? { email: opts.sender.email } : {}),
      ...(opts.sender.inn ? { tin: opts.sender.inn } : {}),
      ...(opts.sender.phone ? { phones: [{ number: opts.sender.phone }] } : {}),
    },
    packages: [
      {
        number: order.number,
        weight: pkg.weight,
        ...(pkg.length !== undefined ? { length: pkg.length } : {}),
        ...(pkg.width !== undefined ? { width: pkg.width } : {}),
        ...(pkg.height !== undefined ? { height: pkg.height } : {}),
        items: items.map((it) => ({
          name: it.nameSnapshot,
          ware_key: it.variantId ?? it.id,
          payment: { value: 0 },
          cost: Number(it.unitPrice),
          amount: it.quantity,
          // Вес ЕДИНИЦЫ из снимка позиции (вариант→товар, 0026); пусто → дефолт магазина.
          weight: itemUnitWeight(it, opts.defaultDimensions.weightG),
        })),
      },
    ],
  };

  // Отправитель: shipment_point ИЛИ from_location (взаимоисключимы).
  if (opts.shipmentPoint) {
    payload.shipment_point = opts.shipmentPoint;
  } else {
    payload.from_location = { code: opts.fromLocationCode };
  }

  // Назначение.
  if (mode === 'pvz' || mode === 'postamat') {
    if (order.deliveryPvzCode) {
      payload.delivery_point = order.deliveryPvzCode;
    } else {
      throw new CdekError(
        'cdek_missing_pvz',
        `Для режима ${mode} требуется код ПВЗ (deliveryPvzCode).`,
      );
    }
  } else {
    // door: адрес получателя (код города у заказа — это название, не числовой код
    // СДЭК; адрес — основное поле для курьерской доставки).
    payload.to_location = {
      ...(order.deliveryAddress ? { address: order.deliveryAddress } : {}),
    };
  }

  return payload;
}

// -----------------------------------------------------------------------------
// Проверка состояния заказа (precondition).
// -----------------------------------------------------------------------------

/**
 * Оплачен ли заказ настолько, чтобы формировать накладную СДЭК (FF.md: накладная
 * создаётся ТОЛЬКО после поступления денег — иначе риск отправить неоплаченное).
 * Признак оплаты: payment_status='paid' (выставляет webhook эквайринга при
 * поступлении средств) ЛИБО статус заказа уже продвинут оператором за оплату
 * (paid/packed/shipped/...). Единый источник правды для cron, сервиса и UI.
 */
export function isOrderPaidForShipment(
  order: Pick<Order, 'paymentStatus' | 'status'>,
): boolean {
  return (
    order.paymentStatus === 'paid' ||
    ['paid', 'packed', 'shipped', 'delivered', 'completed'].includes(order.status)
  );
}

/** Причина, по которой нельзя создать отправление (для сообщения пользователю). */
export type ShipmentBlockReason = 'pickup' | 'not_paid';

/** Человекочитаемое объяснение, почему отправление недоступно. */
export function shipmentBlockMessage(reason: ShipmentBlockReason): string {
  switch (reason) {
    case 'pickup':
      return 'Самовывоз — отправление СДЭК не создаётся.';
    case 'not_paid':
      return 'Заказ ещё не оплачен. Накладная создаётся только после поступления оплаты — это защищает от отправки неоплаченного заказа.';
  }
}

/** Можно ли создавать отправление для заказа (оплачен и не самовывоз). */
export function canCreateShipment(
  order: Order,
): { ok: boolean; reason?: ShipmentBlockReason } {
  if (order.deliveryType === 'pickup') {
    return { ok: false, reason: 'pickup' };
  }
  if (!isOrderPaidForShipment(order)) {
    return { ok: false, reason: 'not_paid' };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// OrderService.
// -----------------------------------------------------------------------------

/** Результат создания отправления в СДЭК (real). */
interface CdekCreateRaw {
  entity?: { uuid?: string };
  requests?: unknown;
}

export class OrderService {
  constructor(private readonly manager: CdekManager = getCdekManager()) {}

  /** Низкоуровневое создание в СДЭК: POST /v2/orders → uuid. */
  async create(payload: CdekOrderPayload): Promise<{ uuid: string }> {
    const raw = await this.manager.client.request<CdekCreateRaw>('POST', '/v2/orders', {
      json: payload,
    });
    const uuid = raw?.entity?.uuid;
    if (!uuid) {
      throw new CdekError('cdek_create_no_uuid', 'СДЭК не вернул uuid отправления.');
    }
    return { uuid };
  }

  /** Низкоуровневая отмена: DELETE до приёмки, PATCH после (порт cancel). */
  async cancel(uuid: string, afterAcceptance = false): Promise<void> {
    if (afterAcceptance) {
      await this.manager.client.request('PATCH', `/v2/orders/${uuid}`, { json: {} });
    } else {
      await this.manager.client.request('DELETE', `/v2/orders/${uuid}`);
    }
  }

  /**
   * Оркестратор создания отправления для заказа (docs/08 §7.1). Идемпотентен:
   *   • уже есть отправление с cdek_uuid → возвращаем его (без force);
   *   • pickup / неоплачен → ошибка precondition;
   *   • mock → фейковый uuid/трек; real → POST /v2/orders.
   * Сохраняет cdek_shipments + денормализует orders.cdek_uuid/cdek_track.
   *
   * АНТИ-ГОНКА (data-integrity). Создание отправления — неатомарный read-then-act:
   * read getShipmentByOrderId → удалённый side-effect POST /v2/orders (real) →
   * только потом INSERT cdek_shipments. UNIQUE uq_cdek_shipments_order защищает
   * лишь локальный INSERT, но НЕ удалённый POST. При гонке (двойной тик cron /
   * ручное создание из админки параллельно с cron) оба вызова видели existing=
   * null, оба POST-или в СДЭК → ДВЕ реальные накладные; второй INSERT падал на
   * unique, оставляя осиротевшую дублирующую накладную в СДЭК.
   *
   * Фикс: ВСЯ критическая секция (re-check существования → выбор источника →
   * (real) удалённый POST → запись cdek_shipments + денормализация orders) идёт
   * внутри ОДНОЙ транзакции под per-order транзакционным advisory-lock
   * pg_try_advisory_xact_lock(hashtext('cdek-create-shipment:'||orderId)). Лок
   * держится до конца транзакции, поэтому удалённый POST для одного заказа делает
   * ТОЛЬКО ОДИН воркер; проигравший try-lock завершается без удалённого вызова
   * (CdekError contention). Перепроверка getShipmentByOrderId ПОД ЛОКОМ ловит
   * случай, когда конкурент успел создать отправление между pre-check и захватом
   * лока — тогда возвращаем существующее (идемпотентность), без второго POST.
   */
  async createShipment(
    orderId: string,
    opts: { force?: boolean } = {},
  ): Promise<CdekShipment> {
    // Быстрый pre-check вне лока: если отправление уже есть — не открываем
    // транзакцию/не берём лок (дешёвый happy-path идемпотентности).
    const pre = await getShipmentByOrderId(orderId);
    if (pre?.cdekUuid && !opts.force) {
      return pre; // идемпотентность: уже создано
    }

    return await sql.begin<CdekShipment>(async (tx: TransactionSql) => {
      // Транзакционный advisory-lock по заказу: только один воркер входит в
      // критическую секцию для данного orderId. Ключ — hashtext(стабильная строка).
      const lockRows = await tx<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtext(${'cdek-create-shipment:' + orderId})
        ) AS locked
      `;
      const acquired = lockRows[0]?.locked === true;
      if (!acquired) {
        // Другой воркер уже создаёт отправление для этого заказа — не дублируем
        // удалённый POST. Понятная ошибка contention (cron посчитает failed,
        // следующий тик подхватит, если первый воркер не довёл до конца).
        throw new CdekError(
          'cdek_create_in_progress',
          `Создание отправления для заказа ${orderId} уже выполняется другим процессом.`,
        );
      }

      // Перепроверка ПОД ЛОКОМ: конкурент мог создать отправление между pre-check
      // и захватом лока → возвращаем существующее (без второго удалённого POST).
      const existing = await getShipmentByOrderId(orderId);
      if (existing?.cdekUuid && !opts.force) {
        return existing;
      }

      return await this.createShipmentLocked(orderId, existing);
    });
  }

  /**
   * Критическая секция создания отправления (вызывается ПОД per-order advisory-
   * lock из createShipment). Загружает заказ, проверяет precondition, выбирает
   * mock/real, пишет cdek_shipments и денормализует orders. На ошибке бампит
   * retry_count (как и раньше) и пробрасывает исключение наружу.
   */
  private async createShipmentLocked(
    orderId: string,
    existing: CdekShipment | null,
  ): Promise<CdekShipment> {
    const loaded: OrderWithItems | null = await getOrderById(orderId);
    if (!loaded) {
      throw new CdekError('cdek_order_not_found', `Заказ ${orderId} не найден.`);
    }
    const { order, items } = loaded;

    const precond = canCreateShipment(order);
    if (!precond.ok) {
      throw new CdekError(
        'cdek_precondition_failed',
        shipmentBlockMessage(precond.reason!),
      );
    }

    const cfg = this.manager.config;
    const mode = deliveryModeFor(order);
    const pkg = aggregatePackage(linesFromItems(items), cfg.defaultDimensions);

    try {
      let cdekUuid: string;
      let cdekNumber: string | null;
      let isMock: boolean;

      if (this.manager.isMock) {
        const r = this.manager.mock.mockCreateShipment();
        cdekUuid = r.cdekUuid;
        cdekNumber = r.cdekNumber;
        isMock = true;
      } else {
        const payload = buildPayload(order, items, {
          defaultDimensions: cfg.defaultDimensions,
          fromLocationCode: cfg.fromLocationCode,
          shipmentPoint: cfg.shipmentPoint,
          defaultTariffCode: cfg.defaultTariffCode,
          doorTariffCode: cfg.doorTariffCode,
          sender: cfg.sender,
        });
        const created = await this.create(payload);
        cdekUuid = created.uuid;
        cdekNumber = null; // трек придёт позже (webhook/tracking)
        isMock = false;
      }

      const shipmentFields = {
        cdekUuid,
        cdekNumber,
        tariffCode: order.deliveryType === 'pickup' ? null : tariffForMode(cfg, mode),
        pvzCode: order.deliveryPvzCode,
        deliveryMode: mode,
        weightG: pkg.weight,
        lengthCm: pkg.length ?? null,
        widthCm: pkg.width ?? null,
        heightCm: pkg.height ?? null,
        isMock,
        error: null,
      };

      // existing-ветка: пере-создание накладной. clearError=true ЯВНО сбрасывает
      // error и retry_count прошлой неудачи (баг B волны 7) — COALESCE(error) при
      // error=null оставил бы старый текст, и оператор видел бы «ошибку» на
      // фактически успешной накладной.
      const saved = existing
        ? await updateShipmentByOrderId(orderId, { ...shipmentFields, clearError: true })
        : await repoCreateShipment({ orderId, ...shipmentFields });

      // Денормализация на orders (горячие поля для списков/витрины).
      await sql`
        UPDATE orders
           SET cdek_uuid = ${cdekUuid},
               cdek_track = ${cdekNumber},
               updated_at = now()
         WHERE id = ${orderId}
      `;

      // БАГ #9 (аудит волны 15): накладная создана (cdek_uuid выставлен) → переводим
      // delivery_status pending→registered. Иначе заказ застревает в 'pending', а первое
      // webhook-событие СДЭК (например in_transit) даёт НЕДОПУСТИМЫЙ переход из pending
      // (машина: pending→registered/cancelled) → статус доставки навсегда залипает.
      // Идемпотентно: applyDeliveryStatus применит переход только если он валиден
      // (из pending); если статус уже продвинут — no-op.
      await applyDeliveryStatus(orderId, 'registered', 'cdek-waybill-created');

      return saved!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (existing) {
        await bumpShipmentRetry(orderId, msg);
      } else {
        await repoCreateShipment({ orderId, error: msg, deliveryMode: mode });
        await bumpShipmentRetry(orderId, msg);
      }
      throw err;
    }
  }

  /**
   * Отмена отправления заказа (docs/08 §7.1). Real: DELETE/PATCH в СДЭК; mock:
   * только пометка. Обновляет статус отправления и delivery_status заказа.
   *
   * БАГ #12 (precondition, анти-рассинхрон): переход delivery_status → cancelled
   * разрешён статус-машиной (lib/orders/status.ts) ТОЛЬКО из pending/registered.
   * Если заказ уже in_transit/delivered/returned/cancelled — applyDeliveryStatus
   * вернул бы false (no-op), а отправление мы бы уже пометили CANCELLED и (в боевом)
   * реально отменили в СДЭК → рассинхрон «отправление CANCELLED ↔ delivery_status
   * остался in_transit». Выбран САМЫЙ БЕЗОПАСНЫЙ вариант: проверяем допустимость
   * перехода ДО любых побочных эффектов (нет вызова СДЭК, нет пометки отправления)
   * и бросаем понятный CdekError. Семантика статус-машины не размывается: посылку,
   * которая уже в пути/доставлена, нельзя «отменить» — для неё существует ветка
   * returned, а не cancelled. Это тот же защитный приём, что canCreateShipment.
   */
  async cancelShipment(
    orderId: string,
    opts: { afterAcceptance?: boolean } = {},
  ): Promise<void> {
    const shipment = await getShipmentByOrderId(orderId);
    if (!shipment?.cdekUuid) {
      throw new CdekError(
        'cdek_no_shipment',
        `Для заказа ${orderId} нет отправления для отмены.`,
      );
    }

    // Precondition: отмена допустима лишь из pending/registered. Иначе — никаких
    // побочных эффектов (СДЭК не дёргаем, отправление не помечаем), понятная ошибка.
    const loaded = await getOrderById(orderId);
    if (!loaded) {
      throw new CdekError('cdek_order_not_found', `Заказ ${orderId} не найден.`);
    }
    const from = loaded.order.deliveryStatus;
    if (!canTransitionDelivery(from, 'cancelled')) {
      throw new CdekError(
        'cdek_cancel_not_allowed',
        `Нельзя отменить отправление: статус доставки "${from}" не допускает отмену ` +
          `(отмена возможна только из pending/registered). Посылку в пути/доставленную ` +
          `следует оформлять через возврат, а не отмену.`,
      );
    }

    if (!this.manager.isMock) {
      await this.cancel(shipment.cdekUuid, opts.afterAcceptance);
    }

    // C6-1 (TOCTOU, анти-рассинхрон): ранняя precondition выше читает delivery_status
    // ДО эффектов, но между ней и переходом параллельный webhook мог продвинуть статус
    // (registered→in_transit). applyDeliveryStatus применяет переход под SELECT … FOR
    // UPDATE — это АВТОРИТЕТНАЯ проверка под локом. Помечаем отправление CANCELLED ТОЛЬКО
    // если переход реально применился; иначе был бы рассинхрон «shipment=CANCELLED ↔
    // delivery_status=in_transit». Не применился (статус успел уйти) → бросаем, отправление
    // НЕ трогаем (оператор сверяет вручную; cancelled — терминал, после успеха гонок нет).
    const applied = await applyDeliveryStatus(orderId, 'cancelled');
    if (!applied) {
      throw new CdekError(
        'cdek_cancel_raced',
        'Статус доставки изменился во время отмены (стал не-отменяемым) — отправление НЕ ' +
          'помечено отменённым. Требуется ручная сверка.',
      );
    }

    await updateShipmentByOrderId(orderId, {
      statusCode: 'CANCELLED',
      statusName: 'Отменён',
      statusAt: new Date(),
    });
  }
}

// -----------------------------------------------------------------------------
// Общий хелпер смены delivery_status (через статус-машину, без Server Actions).
// Реэкспортируется из tracking.ts/webhook.ts через общий модуль.
// -----------------------------------------------------------------------------

import { applyDeliveryStatus } from './delivery-status';
