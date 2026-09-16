/**
 * Аутентификация входящего callback АТОЛ Pay.
 *
 * 🔴 КОНТЕКСТ, ОПРЕДЕЛЯЮЩИЙ ВЕСЬ МОДУЛЬ. У callback АТОЛа НЕТ ПОДПИСИ —
 * ни HMAC, ни секрета уведомлений, ни контрольной суммы (в отличие от Т-Банка
 * и Озона). Тело запроса само по себе НЕ доказывает отправителя: кто угодно,
 * узнав URL вебхука, мог бы объявить неоплаченный заказ оплаченным.
 *
 * Отсюда двухслойная защита, которую проверяет этот файл:
 *   1) секрет в query-параметре notificationUrl, сверяемый за постоянное время;
 *   2) обязательная сверка статуса через API (её проверяет service.test.ts).
 */

import { describe, it, expect } from 'vitest';

import { verifyCallbackSecret, parseCallback, buildNotificationUrl } from '@/lib/payments/atol/callback';

const SECRET = 's'.repeat(32);

describe('atol/callback — 🔴 секрет вместо отсутствующей подписи', () => {
  it('верный секрет принимается', () => {
    expect(verifyCallbackSecret(SECRET, SECRET)).toBe(true);
  });

  it('🔴 неверный секрет отвергается', () => {
    expect(verifyCallbackSecret('x'.repeat(32), SECRET)).toBe(false);
  });

  /**
   * 🔴 Пустой присланный секрет не имеет права совпасть ни с чем: именно так
   * выглядит запрос злоумышленника, который про секрет не знает.
   */
  it('🔴 пустой или отсутствующий секрет отвергается', () => {
    expect(verifyCallbackSecret('', SECRET)).toBe(false);
    expect(verifyCallbackSecret(null, SECRET)).toBe(false);
    expect(verifyCallbackSecret(undefined, SECRET)).toBe(false);
  });

  /**
   * 🔴 Если секрет магазином не настроен, принимать вебхуки НЕЛЬЗЯ вовсе:
   * иначе «проверка» выродится в сравнение пустого с пустым и пропустит всех.
   */
  it('🔴 без настроенного секрета не проходит никто, включая пустышку', () => {
    expect(verifyCallbackSecret('', null)).toBe(false);
    expect(verifyCallbackSecret('что угодно', null)).toBe(false);
    expect(verifyCallbackSecret(null, null)).toBe(false);
  });

  it('секрет другой длины отвергается без падения', () => {
    expect(verifyCallbackSecret('короткий', SECRET)).toBe(false);
    expect(verifyCallbackSecret(SECRET + 'хвост', SECRET)).toBe(false);
  });

  it('регистр значим: секрет сверяется побайтово', () => {
    expect(verifyCallbackSecret(SECRET.toUpperCase(), SECRET)).toBe(false);
  });
});

describe('atol/callback — сборка notificationUrl', () => {
  it('секрет добавляется query-параметром', () => {
    const url = buildNotificationUrl('https://admin.example.ru/api/payments/atol/webhook', SECRET);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('secret')).toBe(SECRET);
  });

  it('существующие query-параметры не теряются', () => {
    const url = buildNotificationUrl('https://admin.example.ru/hook?shop=nm', SECRET);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('shop')).toBe('nm');
    expect(parsed.searchParams.get('secret')).toBe(SECRET);
  });
});

describe('atol/callback — разбор тела', () => {
  it('корректное событие оплаты разбирается', () => {
    const cb = parseCallback({
      status: 'success',
      orderId: 'fcae8e64-1111',
      type: 'payment',
      paymentStatus: 1,
      sessionType: 'oneStep',
      amount: 10000,
      paidAt: '2026-09-16T13:21:00+03:00',
    });
    expect(cb).not.toBeNull();
    expect(cb!.orderId).toBe('fcae8e64-1111');
    expect(cb!.type).toBe('payment');
    expect(cb!.paymentStatus).toBe(1);
  });

  it('событие фискализации разбирается (paymentStatus отсутствует)', () => {
    const cb = parseCallback({
      status: 'fail',
      orderId: 'o-2',
      type: 'fiscal',
      receiptId: 'r-77',
      receiptType: 'sell',
      amount: 10000,
    });
    expect(cb).not.toBeNull();
    expect(cb!.type).toBe('fiscal');
    expect(cb!.receiptId).toBe('r-77');
    expect(cb!.paymentStatus).toBeUndefined();
  });

  it('мусор и неполные тела отвергаются, без исключения', () => {
    expect(parseCallback(null)).toBeNull();
    expect(parseCallback('строка')).toBeNull();
    expect(parseCallback({})).toBeNull();
    expect(parseCallback({ orderId: 'o-1' })).toBeNull();
    expect(parseCallback({ type: 'payment' })).toBeNull();
    expect(parseCallback({ orderId: 'o-1', type: 'нечто' })).toBeNull();
  });

  /**
   * 🔴 Ловушка формата: `status: "success"` — это статус ОБРАБОТКИ ЗАПРОСА,
   * а не факт оплаты. В примере самой документации он соседствует с
   * paymentStatus: 0 («в обработке»). Разбор обязан сохранить оба поля
   * раздельно и ничего не «додумывать».
   */
  it('🔴 status и paymentStatus не смешиваются', () => {
    const cb = parseCallback({
      status: 'success',
      orderId: 'o-3',
      type: 'payment',
      paymentStatus: 0,
    })!;
    expect(cb.status).toBe('success');
    expect(cb.paymentStatus).toBe(0);
  });
});
