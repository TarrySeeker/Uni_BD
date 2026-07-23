/**
 * АВТОВЫПУСК подарочных сертификатов по оплаченному заказу (ТЗ владельца п.11:
 * «при покупке сертификата код создаётся автоматически, попадает в админку и
 * показывается после оформления заказа»).
 *
 * ПОЧЕМУ РЕПОЗИТОРНАЯ ФУНКЦИЯ, А НЕ Server Action: вызывающий — вебхук платёжного
 * провайдера, у которого нет RBAC-контекста (тот же прецедент, что и
 * applyPaymentStatus в lib/payments/tbank/repository.ts). defineAction здесь
 * потребовал бы поддельного пользователя.
 *
 * 🔴 ГЛАВНОЕ ОГРАНИЧЕНИЕ — НИКОГДА НЕ БРОСАТЬ НАРУЖУ.
 * Фиксация оплаты (лог вебхука + переход в paid + пометка processed) идёт в ОДНОЙ
 * транзакции — это осознанный фикс бага неатомарности. Любой throw, случившийся
 * внутри неё, откатил бы САМ ФАКТ ОПЛАТЫ, а повторная доставка вебхука была бы
 * отсечена по UNIQUE(payment_id, status): деньги приняты, заказ висит pending.
 * Поэтому функция:
 *   • открывает СОБСТВЕННЫЕ транзакции (чужую не принимает) — по одной НА КАЖДУЮ
 *     позицию, чтобы падение по позиции 2 не откатывало успех по позиции 1;
 *   • ловит всё и возвращает отчёт; исключений не выпускает вообще.
 *
 * ИДЕМПОТЕНТНОСТЬ держится ТОЛЬКО на частичном UNIQUE (issued_order_item_id) из
 * миграции 0054 (код теперь случайный, см. randomGiftCode). Поэтому 23505 в
 * автопути — это УСПЕХ («уже выпущен»), а не ошибка: иначе крон-догоняльщик
 * вечно ретраил бы одни и те же заказы и шумел в логи.
 *
 * 🔴 КОД СЕРТИФИКАТА НЕ ПОПАДАЕТ В ЛОГИ И В ОТЧЁТ: это деньги на предъявителя, а
 * логи уезжают в docker json-file. Покупателю код отдаётся только по
 * HMAC-токену заказа (email-доступ для этого не годится: номера заказов
 * последовательны, а email покупателей есть в БД).
 */
import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import { logger as appLogger, type Logger } from '@/lib/logger';
import { toMinor } from '@/lib/orders/money';
import { getSetting } from '@/lib/settings/repository';
import { resolveGiftSettings, type ResolvedGiftSettings } from '@/lib/settings/schemas';

import {
  giftFaceValueFromItem,
  giftValidDaysFor,
  giftValidUntil,
  isGiftItemForAutoIssue,
  randomGiftCode,
} from './origin';
import {
  getOrderForAutoIssue,
  insertGiftCertificateTx,
  lockOrderForGiftIssueTx,
  type AutoIssueOrderSnapshot,
  type IssueGiftCertificateRow,
  type IssuedGiftRef,
} from './repository';
import type { GiftParty } from './types';

export type { AutoIssueOrderSnapshot } from './repository';

/** Ключ настроек магазина с параметрами сертификатов. */
const GIFT_SETTINGS_KEY = 'gift';

/** Сколько раз пересоздаём код при маловероятной коллизии UNIQUE(code). */
const CODE_RETRIES = 3;

/** Код нарушения UNIQUE в PostgreSQL. */
const PG_UNIQUE_VIOLATION = '23505';

/** Частичный UNIQUE из 0054 — «на позицию заказа не больше одного сертификата». */
const ISSUED_ITEM_UNIQUE = 'gift_certificates_issued_item_uniq';

function pgError(err: unknown): { code?: string; constraint_name?: string } {
  return (err ?? {}) as { code?: string; constraint_name?: string };
}

function isUniqueViolation(err: unknown): boolean {
  return pgError(err).code === PG_UNIQUE_VIOLATION;
}

/** Нарушение именно по позиции заказа (а не по коду) → «уже выпущен». */
function isDuplicateItemViolation(err: unknown): boolean {
  const e = pgError(err);
  return e.code === PG_UNIQUE_VIOLATION && String(e.constraint_name ?? '').includes('issued_item');
}

// -----------------------------------------------------------------------------
// Отчёт.
// -----------------------------------------------------------------------------

/** Почему по заказу не выпущено ничего (все причины — штатные, не аварии). */
export type AutoIssueSkipReason =
  | 'auto_issue_disabled'
  | 'order_not_found'
  | 'order_not_paid'
  | 'order_not_eligible'
  | 'paid_with_gift'
  | 'no_gift_items'
  | 'error';

/** Что случилось с конкретной позицией. */
export interface AutoIssueItemOutcome {
  orderItemId: string;
  status: 'issued' | 'skipped' | 'failed';
  reason?: 'already_issued' | 'zero_amount' | 'error';
  /** id выпущенного сертификата. Самого КОДА здесь намеренно нет — см. шапку. */
  certificateId?: string;
}

/** Итог автовыпуска по заказу. Никогда не заменяет собой исключение — их нет. */
export interface AutoIssueReport {
  orderId: string;
  /** false — что-то не доехало (есть failed или сбой чтения); заказ подхватит крон. */
  ok: boolean;
  issued: number;
  skipped: number;
  failed: number;
  reason?: AutoIssueSkipReason;
  items: AutoIssueItemOutcome[];
}

function emptyReport(orderId: string, reason: AutoIssueSkipReason, ok = true): AutoIssueReport {
  return { orderId, ok, issued: 0, skipped: 0, failed: 0, reason, items: [] };
}

// -----------------------------------------------------------------------------
// Зависимости (инъекция для юнитов без БД).
// -----------------------------------------------------------------------------

export interface AutoIssueDeps {
  /**
   * Политика УЖЕ разрешённая (дефолты ⊕ оверрайд). Тип не оставлен частичным
   * намеренно: «поля нет» на этой границе означало бы свой дефолт у выпуска,
   * то есть второй источник правды рядом с формой админки.
   */
  getGiftSettings: () => Promise<ResolvedGiftSettings>;
  getOrderForAutoIssue: (orderId: string) => Promise<AutoIssueOrderSnapshot | null>;
  /** Выполняет callback в СОБСТВЕННОЙ транзакции (одна на позицию). */
  withTransaction: <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;
  lockOrderTx: (tx: TransactionSql, orderId: string) => Promise<void>;
  insertGiftTx: (tx: TransactionSql, row: IssueGiftCertificateRow) => Promise<IssuedGiftRef>;
  logger: Logger;
  randomCode: () => string;
}

/**
 * Прод-зависимости (реальная БД, настройки из shop_settings).
 *
 * Политика резолвится ТЕМ ЖЕ resolveGiftSettings, что рисует форму в админке
 * (lib/settings/schemas). Своих дефолтов здесь нет: когда они были, «Сбросить
 * настройки сертификатов» оставляло форму с включённым автовыпуском, а выдачу
 * денег на предъявителя — выключенной.
 */
export function productionAutoIssueDeps(): AutoIssueDeps {
  return {
    getGiftSettings: async () => resolveGiftSettings((await getSetting(GIFT_SETTINGS_KEY))?.value),
    getOrderForAutoIssue,
    withTransaction: <T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> =>
      sql.begin(fn) as Promise<T>,
    lockOrderTx: lockOrderForGiftIssueTx,
    insertGiftTx: insertGiftCertificateTx,
    logger: appLogger.child({ module: 'gift-auto-issue' }),
    randomCode: randomGiftCode,
  };
}

// -----------------------------------------------------------------------------
// Конвейер.
// -----------------------------------------------------------------------------

/** Заказ пригоден к автовыпуску (оплачен и не отменён/возвращён). */
function orderGateReason(order: AutoIssueOrderSnapshot): AutoIssueSkipReason | null {
  if (order.paymentStatus !== 'paid') return 'order_not_paid';
  if (order.status === 'cancelled' || order.status === 'refunded') return 'order_not_eligible';
  return null;
}

export function createGiftAutoIssuer(deps: AutoIssueDeps) {
  /**
   * Выпускает сертификаты по всем позициям-сертификатам ОПЛАЧЕННОГО заказа.
   * Не бросает: любой сбой отражается в отчёте (см. шапку модуля).
   */
  async function autoIssueGiftsForPaidOrder(orderId: string): Promise<AutoIssueReport> {
    try {
      const settings = await deps.getGiftSettings();
      if (settings.autoIssue !== true) {
        return emptyReport(orderId, 'auto_issue_disabled');
      }

      const order = await deps.getOrderForAutoIssue(orderId);
      if (!order) {
        deps.logger.warn('автовыпуск: заказ не найден', { orderId });
        return emptyReport(orderId, 'order_not_found');
      }

      const gate = orderGateReason(order);
      if (gate) return emptyReport(orderId, gate);

      // Заказ, оплаченный САМИМ сертификатом, по умолчанию не порождает новый:
      // иначе баланс переливается сам в себя без движения денег магазина.
      if (order.giftCertificateId && settings.allowIssueOnGiftPaidOrder !== true) {
        return emptyReport(orderId, 'paid_with_gift');
      }

      const giftItems = order.items.filter((item) => isGiftItemForAutoIssue(item, settings));
      if (giftItems.length === 0) {
        return emptyReport(orderId, 'no_gift_items');
      }

      // Снимок покупателя заказа: он же получатель (кому вручить — решает сам
      // покупатель; персонализация получателя доступна в ручном выпуске).
      const party: GiftParty = {
        name: order.customerName || null,
        email: order.customerEmail || null,
        phone: order.customerPhone || null,
      };

      const items: AutoIssueItemOutcome[] = [];
      for (const item of giftItems) {
        const faceValue = giftFaceValueFromItem(item);
        if (toMinor(faceValue) <= 0) {
          // Позиция за 0 (подарок/полная скидка) — сертификата на ноль не бывает.
          items.push({ orderItemId: item.id, status: 'skipped', reason: 'zero_amount' });
          continue;
        }

        const validUntil = giftValidUntil(order.paidAt, giftValidDaysFor(item, settings));
        items.push(await issueOneItem(order, item.id, item.nameSnapshot, faceValue, validUntil, party));
      }

      const issued = items.filter((i) => i.status === 'issued').length;
      const failed = items.filter((i) => i.status === 'failed').length;
      const report: AutoIssueReport = {
        orderId,
        ok: failed === 0,
        issued,
        skipped: items.length - issued - failed,
        failed,
        items,
      };
      deps.logger.info('автовыпуск сертификатов завершён', {
        orderId,
        issued: report.issued,
        skipped: report.skipped,
        failed: report.failed,
      });
      return report;
    } catch (err) {
      // Наружу не выпускаем НИЧЕГО: вызывающий — транзакция фиксации оплаты.
      deps.logger.error('автовыпуск сертификатов сорвался', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyReport(orderId, 'error', false);
    }
  }

  /** Одна позиция = одна транзакция (advisory-lock + INSERT), с ретраями кода. */
  async function issueOneItem(
    order: AutoIssueOrderSnapshot,
    orderItemId: string,
    itemName: string,
    faceValue: string,
    validUntil: Date | null,
    party: GiftParty,
  ): Promise<AutoIssueItemOutcome> {
    for (let attempt = 1; attempt <= CODE_RETRIES; attempt += 1) {
      try {
        const cert = await deps.withTransaction(async (tx) => {
          // Лок не ради корректности (её даёт частичный UNIQUE), а чтобы вебхук
          // и крон не бодались конфликтующими транзакциями по одному заказу.
          await deps.lockOrderTx(tx, order.orderId);
          const row: IssueGiftCertificateRow = {
            code: deps.randomCode(),
            name: itemName,
            initialAmount: faceValue,
            validUntil,
            description: null,
            terms: null,
            comment: '',
            translations: {},
            purchaser: party,
            purchaserCustomerId: order.customerId,
            recipient: party,
            issuedOrderId: order.orderId,
            issuedOrderItemId: orderItemId,
            issueSource: 'auto',
          };
          return deps.insertGiftTx(tx, row);
        });
        return { orderItemId, status: 'issued', certificateId: cert.id };
      } catch (err) {
        if (isDuplicateItemViolation(err)) {
          // Уже выпущен (повторный вебхук / гонка с ручной кнопкой) — это УСПЕХ.
          return { orderItemId, status: 'skipped', reason: 'already_issued' };
        }
        if (isUniqueViolation(err)) {
          // Коллизия по значению кода — пробуем новое (или сдаёмся как «уже есть»).
          if (attempt < CODE_RETRIES) continue;
          return { orderItemId, status: 'skipped', reason: 'already_issued' };
        }
        deps.logger.error('автовыпуск: позиция не выпущена', {
          orderId: order.orderId,
          orderItemId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { orderItemId, status: 'failed', reason: 'error' };
      }
    }
    return { orderItemId, status: 'failed', reason: 'error' };
  }

  return { autoIssueGiftsForPaidOrder };
}

/** Прод-обёртка: вызывается вебхуками оплаты и кроном-догоняльщиком. */
export function autoIssueGiftsForPaidOrder(orderId: string): Promise<AutoIssueReport> {
  return createGiftAutoIssuer(productionAutoIssueDeps()).autoIssueGiftsForPaidOrder(orderId);
}
