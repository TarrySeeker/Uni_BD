/**
 * Маппинг числовых статусов АТОЛ Pay → orders.payment_status.
 *
 * Чистая логика: ни сети, ни БД. Это место, где ошибка стоит дороже всего —
 * неверный маппинг либо пометит заказ оплаченным без денег, либо освободит
 * резерв остатков при частичном возврате.
 */

import { describe, it, expect } from 'vitest';

import { ATOL_PAYMENT_STATUS } from '@/lib/payments/atol/types';
import {
  mapPaymentStatus,
  describeAtolStatus,
  describeErrorCode,
} from '@/lib/payments/atol/status-map';

describe('payments/atol — маппинг числовых статусов', () => {
  it('success (1) → paid: единственный статус, дающий «оплачено»', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.success)).toBe('paid');
    expect(mapPaymentStatus(1)).toBe('paid');
  });

  it('awaitingDeposit (11) → authorized: деньги захолдированы, но не списаны', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.awaitingDeposit)).toBe('authorized');
  });

  it('processing (0) и confirm3ds (10) → pending: исход ещё не определён', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.processing)).toBe('pending');
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.confirm3ds)).toBe('pending');
  });

  it('error (3), canceled (4), fraud (6), overdue (9) → failed', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.error)).toBe('failed');
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.canceled)).toBe('failed');
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.fraud)).toBe('failed');
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.paymentIsOverdue)).toBe('failed');
  });

  it('refunded (5) → refunded: полный возврат, терминальный сетл', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.refunded)).toBe('refunded');
  });

  /**
   * 🔴 Главная защита этого модуля. Авто-переход частичного возврата в
   * `refunded` закрыл бы заказ целиком: освободился бы ВЕСЬ резерв остатков и
   * откатился промокод, хотя вернулась лишь часть денег. Тот же баг уже лечили
   * в Т-Банке и обошли в Озоне — здесь он не должен появиться заново.
   */
  it('🔴 частичные возвраты (7, 8) НЕ маппятся — решает оператор', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.partialCancel)).toBeNull();
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.partialRefund)).toBeNull();
  });

  /**
   * notResponding и retryError — не отказ, а «неизвестно»: повтор возможен.
   * Пометить заказ failed значило бы отпустить резерв под платёж, который
   * ещё может успешно завершиться.
   */
  it('notResponding (2) и retryError (12) НЕ маппятся: повтор возможен', () => {
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.notResponding)).toBeNull();
    expect(mapPaymentStatus(ATOL_PAYMENT_STATUS.retryError)).toBeNull();
  });

  it('неизвестный, отсутствующий и нечисловой статус → null, без падения', () => {
    expect(mapPaymentStatus(99)).toBeNull();
    expect(mapPaymentStatus(undefined)).toBeNull();
    expect(mapPaymentStatus(null)).toBeNull();
    expect(mapPaymentStatus(Number.NaN)).toBeNull();
  });

  /**
   * 🔴 Ловушка формата: paymentStatus приходит числом, и 0 — ЗНАЧАЩЕЕ значение
   * («в обработке»). Реализация не имеет права отбрасывать его как falsy.
   */
  it('🔴 статус 0 значащий, а не «пусто»', () => {
    expect(mapPaymentStatus(0)).toBe('pending');
    expect(mapPaymentStatus(0)).not.toBeNull();
  });

  /**
   * 🔴 Строка вместо числа: «1» не должна молча стать оплатой. Так уже стреляло
   * у Озон Банка (рубли-строка вместо копеек). Требуем строгую типизацию —
   * нестрогое приведение здесь недопустимо.
   */
  it('🔴 строковый «1» не считается оплатой', () => {
    expect(mapPaymentStatus('1' as unknown as number)).toBeNull();
  });

  it('человекочитаемые описания статусов и кодов ошибок', () => {
    expect(describeAtolStatus(1)).toContain('спех');
    expect(describeAtolStatus(7)).toBeTruthy();
    expect(describeAtolStatus(99)).toContain('99');
    expect(describeErrorCode('AUTH_ERROR')).toBeTruthy();
    expect(describeErrorCode(undefined)).toBeNull();
    expect(describeErrorCode('WAT_IS_THIS')).toContain('WAT_IS_THIS');
  });
});
