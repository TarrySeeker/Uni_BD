'use server';

import { z } from 'zod';

import { defineAction, PublicActionError } from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { OrderService } from './services/order';
import { TrackingService } from './services/tracking';
import { PrintService } from './services/print';
import { CdekError } from './errors';

/**
 * Server Actions модуля cdek (docs/08 §10.1).
 *
 * Все мутации — через единый пайплайн defineAction (ядро §4.7): guard
 * (cdek.manage) → Zod → handler (вызов сервиса СДЭК) → revalidate карточки
 * заказа → audit `cdek.*`. Доменные ошибки — CdekError из lib/cdek/errors.ts
 * (класс НЕ объявляется в этом 'use server'-файле, только импортируется).
 *
 * Флаг модуля: каждый handler await assertCdekEnabled() — авторитетный гейт
 * (env ⊕ БД-оверрайд) отклоняет вызов при выключенном модуле (помимо скрытия в UI).
 *
 * Бизнес-логика (создание/отмена/трек/печать) — внутри сервисов
 * lib/cdek/services/* через getCdekManager(); здесь только оркестрация пайплайна.
 */

// -----------------------------------------------------------------------------
// Общие хелперы.
// -----------------------------------------------------------------------------

/** Бросает, если модуль cdek выключен (env ⊕ БД-оверрайд). */
async function assertCdekEnabled(): Promise<void> {
  if (!(await isModuleEffectivelyEnabled('cdek'))) {
    throw new CdekError('module_disabled', 'Модуль «СДЭК» выключен.');
  }
}

/**
 * Коды CdekError, чьё сообщение безопасно и полезно показать оператору в форме
 * (бизнес-правило сознательно отклонило действие — это НЕ внутренняя ошибка).
 * Главный кейс — `cdek_precondition_failed` при неоплаченном заказе (FF.md):
 * без этого defineAction свернул бы CdekError в безликий `internal`.
 */
const USER_FACING_CDEK_CODES = new Set([
  'cdek_precondition_failed',
  'cdek_missing_pvz',
  'cdek_invalid_phone',
  'cdek_no_shipment',
]);

/**
 * Выполняет операцию СДЭК, переводя «понятные» доменные CdekError в
 * PublicActionError → форма покажет текст пользователю; прочие ошибки уходят в
 * `internal` (детали — только в лог сервера).
 */
async function withUserFacingCdekError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CdekError && USER_FACING_CDEK_CODES.has(err.code)) {
      throw new PublicActionError(err.message);
    }
    throw err;
  }
}

/** Путь инвалидации карточки заказа. */
function orderPath(orderId: string): string {
  return `/admin/orders/${orderId}`;
}

/** Вход «только orderId» (общий для большинства действий). */
const OrderIdSchema = z.object({ orderId: z.string().uuid() });

/** Вход создания (с опц. force-перевыпуском). */
const CreateShipmentSchema = z.object({
  orderId: z.string().uuid(),
  force: z.boolean().optional(),
});

/** Вход печати (накладная по умолчанию либо ШК). */
const LabelSchema = z.object({
  orderId: z.string().uuid(),
  kind: z.enum(['waybill', 'barcode']).optional(),
});

// -----------------------------------------------------------------------------
// createCdekShipment — создание отправления (audit cdek.shipment.create).
// -----------------------------------------------------------------------------

export const createCdekShipment = defineAction({
  permission: 'cdek.manage',
  input: CreateShipmentSchema,
  handler: async ({ orderId, force }) => {
    await assertCdekEnabled();
    const shipment = await withUserFacingCdekError(() =>
      new OrderService().createShipment(orderId, { force }),
    );
    return {
      result: {
        id: shipment.id,
        cdekUuid: shipment.cdekUuid,
        cdekNumber: shipment.cdekNumber,
        isMock: shipment.isMock,
      },
      revalidate: [orderPath(orderId)],
      audit: {
        action: 'cdek.shipment.create',
        entityType: 'cdek_shipment',
        entityId: shipment.id,
        after: { cdekUuid: shipment.cdekUuid, cdekNumber: shipment.cdekNumber },
      },
    };
  },
});

// -----------------------------------------------------------------------------
// cancelCdekShipment — отмена отправления (audit cdek.shipment.cancel).
// -----------------------------------------------------------------------------

export const cancelCdekShipment = defineAction({
  permission: 'cdek.manage',
  input: OrderIdSchema,
  handler: async ({ orderId }) => {
    await assertCdekEnabled();
    await withUserFacingCdekError(() => new OrderService().cancelShipment(orderId));
    return {
      result: { orderId, cancelled: true },
      revalidate: [orderPath(orderId)],
      audit: {
        action: 'cdek.shipment.cancel',
        entityType: 'cdek_shipment',
        entityId: orderId,
        after: { cancelled: true },
      },
    };
  },
});

// -----------------------------------------------------------------------------
// refreshCdekStatus — pull-обновление статуса (audit cdek.status.sync).
// -----------------------------------------------------------------------------

export const refreshCdekStatus = defineAction({
  permission: 'cdek.manage',
  input: OrderIdSchema,
  handler: async ({ orderId }) => {
    await assertCdekEnabled();
    const res = await new TrackingService().refreshStatus(orderId);
    return {
      result: res,
      revalidate: [orderPath(orderId)],
      audit: {
        action: 'cdek.status.sync',
        entityType: 'cdek_shipment',
        entityId: orderId,
        after: {
          statusCode: res.statusCode,
          deliveryStatus: res.appliedDeliveryStatus,
          transitioned: res.transitioned,
        },
      },
    };
  },
});

// -----------------------------------------------------------------------------
// getCdekLabel — URL накладной/ШК (audit cdek.print.label).
// -----------------------------------------------------------------------------

export const getCdekLabel = defineAction({
  permission: 'cdek.manage',
  input: LabelSchema,
  handler: async ({ orderId, kind }) => {
    await assertCdekEnabled();
    const { url } = await new PrintService().getShipmentLabel(orderId, { kind });
    return {
      result: { url },
      // печать не меняет данные заказа — инвалидация не нужна (URL вернётся клиенту);
      // но print_url сохраняется в shipment, поэтому обновим карточку.
      revalidate: [orderPath(orderId)],
      audit: {
        action: 'cdek.print.label',
        entityType: 'cdek_shipment',
        entityId: orderId,
        after: { kind: kind ?? 'waybill', url },
      },
    };
  },
});
