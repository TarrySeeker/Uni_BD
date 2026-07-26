'use server';

import { z } from 'zod';

import { defineAction, PublicActionError } from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { OrderService } from './services/order';
import { TrackingService } from './services/tracking';
import { PrintService } from './services/print';
import { CdekError } from './errors';
import { isUserFacingCdekCode } from './user-facing';

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

/**
 * Бросает, если модуль cdek выключен (env ⊕ БД-оверрайд).
 *
 * Через ту же обёртку, что и вызовы сервисов: иначе выключенный модуль читался
 * оператором как «внутренняя ошибка» вместо «Модуль «СДЭК» выключен» (аудит №32).
 */
async function assertCdekEnabled(): Promise<void> {
  await withUserFacingCdekError(async () => {
    if (!(await isModuleEffectivelyEnabled('cdek'))) {
      throw new CdekError('module_disabled', 'Модуль «СДЭК» выключен.');
    }
  });
}

/**
 * Выполняет операцию СДЭК, переводя «понятные» доменные CdekError в
 * PublicActionError → форма покажет текст пользователю; прочие ошибки уходят в
 * `internal` (детали — только в лог сервера).
 *
 * Набор «понятных» кодов — lib/cdek/user-facing.ts (этот модуль 'use server' и
 * не может экспортировать константу). Аудит №32: раньше в наборе было 4 кода,
 * из-за чего осмысленные отказы («PDF ещё не готов», «отмена в пути запрещена»)
 * показывались оператору как «внутренняя ошибка».
 */
async function withUserFacingCdekError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUserFacingCdekCode(err)) {
      throw new PublicActionError((err as CdekError).message);
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
    // Аудит №32: обёртка нужна и здесь — иначе доменный отказ синхронизации
    // (напр. выключенный модуль) оператор видит как «внутреннюю ошибку».
    const res = await withUserFacingCdekError(() =>
      new TrackingService().refreshStatus(orderId),
    );
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
    // Аудит №32: 'cdek_print_not_ready' («PDF ещё не готов — повторите позже»)
    // обязан доехать до оператора текстом, а не безликим internal.
    const { url } = await withUserFacingCdekError(() =>
      new PrintService().getShipmentLabel(orderId, { kind }),
    );
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
