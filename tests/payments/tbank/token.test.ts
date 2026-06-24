import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildTokenSource,
  signToken,
  verifyNotificationToken,
} from '@/lib/payments/tbank/token';

/**
 * Юнит-тесты подписи Token Т-Банка (docs/15 §5). ЧИСТЫЕ, без сети/БД — всегда
 * зелёные. Алгоритм (§5.1): корневые скалярные поля + Password, отсортированные
 * по ключу, значения конкатенированы, SHA-256 hex lowercase. Вложенные объекты
 * (Receipt/DATA) и сам Token в подпись НЕ идут.
 */

// Эталонный набор полей из официальной доки Т-Банка (docs/15 §5.1):
// TerminalKey, Amount, OrderId, Description + Password →
// сортировка по ключу: Amount, Description, OrderId, Password, TerminalKey.
const PASSWORD = 'usaf8fw8fsw21g';
const DOC_PAYLOAD = {
  TerminalKey: 'MerchantTerminalKey',
  Amount: 19200,
  OrderId: '21090',
  Description: 'Подарочная карта на 1000 рублей',
};

describe('tbank/token — buildTokenSource (конкатенация значений по §5.1)', () => {
  it('исключает Token и вложенные объекты, добавляет Password, сортирует по ключу', () => {
    const src = buildTokenSource(DOC_PAYLOAD, PASSWORD);
    // Порядок ключей: Amount, Description, OrderId, Password, TerminalKey →
    // значения склеены без разделителей.
    const expected =
      '19200' +
      'Подарочная карта на 1000 рублей' +
      '21090' +
      PASSWORD +
      'MerchantTerminalKey';
    expect(src).toBe(expected);
  });

  it('вложенные Receipt/DATA и поле Token не участвуют в подписи', () => {
    const withNested = {
      ...DOC_PAYLOAD,
      Token: 'should-be-ignored',
      Receipt: { Taxation: 'usn_income', Items: [{ Name: 'x', Price: 1 }] },
      DATA: { foo: 'bar' },
    };
    expect(buildTokenSource(withNested, PASSWORD)).toBe(
      buildTokenSource(DOC_PAYLOAD, PASSWORD),
    );
  });

  it('булевы сериализуются как "true"/"false", числа — строкой', () => {
    const src = buildTokenSource({ A: true, B: false, C: 7 }, 'pw');
    // Ключи сортируются: A, B, C, Password.
    expect(src).toBe('true' + 'false' + '7' + 'pw');
  });

  it('null/undefined значения пропускаются (не вносят пустую строку)', () => {
    const src = buildTokenSource({ A: 'x', B: null, C: undefined }, 'pw');
    // Только A и Password.
    expect(src).toBe('x' + 'pw');
  });
});

describe('tbank/token — signToken (SHA-256 hex lowercase)', () => {
  it('эталонный вектор: SHA-256 от конкатенации значений = ожидаемый hex', () => {
    const expectedHex = createHash('sha256')
      .update(
        '19200' +
          'Подарочная карта на 1000 рублей' +
          '21090' +
          PASSWORD +
          'MerchantTerminalKey',
        'utf8',
      )
      .digest('hex');
    expect(signToken(DOC_PAYLOAD, PASSWORD)).toBe(expectedHex);
  });

  it('результат — нижний регистр hex, длина 64', () => {
    const t = signToken(DOC_PAYLOAD, PASSWORD);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('детерминирован: одни входы → один Token', () => {
    expect(signToken(DOC_PAYLOAD, PASSWORD)).toBe(signToken(DOC_PAYLOAD, PASSWORD));
  });

  it('изменение значения меняет Token', () => {
    expect(signToken({ ...DOC_PAYLOAD, Amount: 19201 }, PASSWORD)).not.toBe(
      signToken(DOC_PAYLOAD, PASSWORD),
    );
  });

  it('изменение пароля меняет Token', () => {
    expect(signToken(DOC_PAYLOAD, 'other-pw')).not.toBe(signToken(DOC_PAYLOAD, PASSWORD));
  });
});

describe('tbank/token — verifyNotificationToken (§5.2)', () => {
  it('валидный Token, пересобранный тем же алгоритмом, проходит', () => {
    const body: Record<string, unknown> = {
      TerminalKey: 'TK',
      OrderId: '2026-000123',
      Success: true,
      Status: 'CONFIRMED',
      PaymentId: '900000001',
      Amount: 150000,
    };
    body.Token = signToken(body, PASSWORD);
    expect(verifyNotificationToken(body, PASSWORD)).toBe(true);
  });

  it('подделанный Token отклоняется', () => {
    const body: Record<string, unknown> = {
      OrderId: '2026-000123',
      Status: 'CONFIRMED',
      PaymentId: '900000001',
      Token: 'deadbeef',
    };
    expect(verifyNotificationToken(body, PASSWORD)).toBe(false);
  });

  it('изменённая после подписи сумма ломает верификацию (anti-tamper)', () => {
    const body: Record<string, unknown> = {
      OrderId: '2026-000123',
      Status: 'CONFIRMED',
      PaymentId: '900000001',
      Amount: 150000,
    };
    body.Token = signToken(body, PASSWORD);
    body.Amount = 1; // покупатель пытается занизить
    expect(verifyNotificationToken(body, PASSWORD)).toBe(false);
  });

  it('отсутствие Token → false', () => {
    expect(verifyNotificationToken({ OrderId: 'x' }, PASSWORD)).toBe(false);
  });

  it('неверный пароль → false', () => {
    const body: Record<string, unknown> = { OrderId: 'x', Status: 'NEW' };
    body.Token = signToken(body, PASSWORD);
    expect(verifyNotificationToken(body, 'wrong')).toBe(false);
  });
});
