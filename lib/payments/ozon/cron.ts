/**
 * Крон-воркер сверки платежей Ozon (порт lib/payments/tbank/cron.ts).
 *
 * Зачем: уведомление банка может не дойти — сетевой сбой, недоступность сервера,
 * ошибка на стороне Ozon. Тогда деньги списаны, а заказ навсегда остался бы
 * в статусе «ожидает оплаты»: покупатель заплатил, магазин об этом не знает.
 * Сверка сама опрашивает банк по «зависшим» заказам и доводит статус.
 *
 * Идемпотентна: применяет только допустимые переходы через статус-машину,
 * повторный запуск безопасен.
 */

import { logger } from '@/lib/logger';
import { getOzonConfig, isOzonMock } from './config';
import { ozonPost } from './client';
import { OzonError } from './errors';
import { signOrderLookup } from './sign';
import { mapOrderStatus } from './status-map';
import { findPendingOzonPayments, applyPaymentStatus } from './repository';
import type { OzonOrderStatusResponse } from './types';

const log = logger.child({ module: 'payments/ozon/cron' });

/** Сколько заказов проверяем за один запуск — чтобы не упереться в лимиты API. */
export const RECONCILE_PENDING_LIMIT = 50;

export interface OzonReconcileStats {
  /** Сколько заказов рассмотрено. */
  checked: number;
  /** По скольким статус изменился. */
  updated: number;
  /** По скольким запрос к банку не удался. */
  failed: number;
  /** Пропущено (mock-режим / нечего сверять). */
  skipped: boolean;
}

/**
 * Опрашивает банк по заказам с незавершённой оплатой и доводит статус.
 * Ошибка по одному заказу не останавливает остальные.
 */
export async function runOzonReconcilePending(): Promise<OzonReconcileStats> {
  if (isOzonMock()) {
    log.warn('ozon.cron: mock-режим — сверка пропущена');
    return { checked: 0, updated: 0, failed: 0, skipped: true };
  }

  const cfg = getOzonConfig();
  const accessKey = cfg.accessKey!;
  const secretKey = cfg.secretKey!;

  const pending = await findPendingOzonPayments(RECONCILE_PENDING_LIMIT);
  if (pending.length === 0) {
    return { checked: 0, updated: 0, failed: 0, skipped: false };
  }

  let updated = 0;
  let failed = 0;

  for (const p of pending) {
    try {
      const requestSign = signOrderLookup({
        id: p.ozonOrderId,
        extId: '',
        accessKey,
        secretKey,
      });
      const res = await ozonPost<OzonOrderStatusResponse>(cfg.baseUrl, 'getOrderStatus', {
        accessKey,
        id: p.ozonOrderId,
        requestSign,
      });

      const next = mapOrderStatus(res.status);
      if (!next || next === p.paymentStatus) continue;

      const applied = await applyPaymentStatus(
        p.orderId,
        next,
        `Ozon: сверка крона (${res.status})`,
      );
      if (applied) {
        updated += 1;
        log.info('ozon.cron: статус оплаты доведён сверкой', {
          orderNumber: p.orderNumber,
          from: p.paymentStatus,
          to: next,
          ozonStatus: res.status ?? null,
        });
      }
    } catch (e) {
      failed += 1;
      const isOzon = e instanceof OzonError;
      log.warn('ozon.cron: не удалось сверить заказ', {
        orderNumber: p.orderNumber,
        code: isOzon ? e.code : null,
        requestId: isOzon ? e.requestId : null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { checked: pending.length, updated, failed, skipped: false };
}
