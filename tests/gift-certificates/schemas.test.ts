import { describe, it, expect } from 'vitest';

import {
  giftCodeSchema,
  giftFaceValueSchema,
  IssueGiftCertificateSchema,
  UpdateGiftCertificateSchema,
  SetGiftStatusSchema,
  IssueGiftFromOrderSchema,
  giftPartySchema,
} from '@/lib/gift-certificates/schemas';

describe('gift-certificates/schemas — код и номинал', () => {
  it('код: непустой, тримится, до 64 символов', () => {
    expect(giftCodeSchema.parse('  GIFT500 ')).toBe('GIFT500');
    expect(giftCodeSchema.safeParse('').success).toBe(false);
    expect(giftCodeSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('номинал: строго > 0', () => {
    expect(giftFaceValueSchema.parse('500.00')).toBe('500.00');
    expect(giftFaceValueSchema.safeParse('0.00').success).toBe(false);
    expect(giftFaceValueSchema.safeParse('0').success).toBe(false);
    expect(giftFaceValueSchema.safeParse('-5.00').success).toBe(false);
    expect(giftFaceValueSchema.safeParse('12.345').success).toBe(false);
  });
});

describe('gift-certificates/schemas — IssueGiftCertificateSchema', () => {
  it('минимальный валидный вход', () => {
    const r = IssueGiftCertificateSchema.safeParse({ code: 'GIFT', initialAmount: '1000.00' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe('');
  });

  it('нулевой номинал отклоняется', () => {
    expect(IssueGiftCertificateSchema.safeParse({ code: 'G', initialAmount: '0.00' }).success).toBe(false);
  });

  it('validUntil как ISO → Date; null допустим', () => {
    const r = IssueGiftCertificateSchema.safeParse({
      code: 'G',
      initialAmount: '100.00',
      validUntil: '2030-01-01T00:00:00Z',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.validUntil).toBeInstanceOf(Date);

    const r2 = IssueGiftCertificateSchema.safeParse({ code: 'G', initialAmount: '100.00', validUntil: null });
    expect(r2.success).toBe(true);
  });

  it('translations принимается как блок (тонкая фильтрация — на сервере)', () => {
    const r = IssueGiftCertificateSchema.safeParse({
      code: 'G',
      initialAmount: '100.00',
      description: 'Подарок',
      translations: { en: { description: 'Gift', terms: 'Terms' } },
    });
    expect(r.success).toBe(true);
  });
});

describe('gift-certificates/schemas — Update / SetStatus', () => {
  it('Update: id обязателен (uuid), остальное partial', () => {
    expect(UpdateGiftCertificateSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    const r = UpdateGiftCertificateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      initialAmount: '2000.00',
    });
    expect(r.success).toBe(true);
  });

  it('SetStatus: только active|disabled', () => {
    expect(
      SetGiftStatusSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', status: 'disabled' }).success,
    ).toBe(true);
    expect(
      SetGiftStatusSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', status: 'depleted' }).success,
    ).toBe(false);
  });
});

describe('gift-certificates/schemas — стороны сделки (ТЗ п.7)', () => {
  it('все поля стороны опциональны (владелец может знать только имя)', () => {
    expect(giftPartySchema.safeParse({}).success).toBe(true);
    expect(giftPartySchema.safeParse({ name: 'Мария' }).success).toBe(true);
    expect(giftPartySchema.safeParse({ email: null, phone: null }).success).toBe(true);
  });

  it('email валидируется, пустая строка допустима (нормализуется в null)', () => {
    expect(giftPartySchema.safeParse({ email: 'a@b.io' }).success).toBe(true);
    expect(giftPartySchema.safeParse({ email: '' }).success).toBe(true);
    expect(giftPartySchema.safeParse({ email: 'не-email' }).success).toBe(false);
  });

  it('issue/update принимают блоки purchaser/recipient', () => {
    const issue = IssueGiftCertificateSchema.safeParse({
      code: 'G1',
      initialAmount: '100.00',
      purchaser: { name: 'Иван' },
      recipient: { name: 'Мария' },
    });
    expect(issue.success).toBe(true);
    const upd = UpdateGiftCertificateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      recipient: { name: 'Мария' },
    });
    expect(upd.success).toBe(true);
  });
});

describe('gift-certificates/schemas — IssueGiftFromOrderSchema', () => {
  const base = {
    orderId: '22222222-2222-4222-8222-222222222222',
    orderItemId: '33333333-3333-4333-8333-333333333333',
  };

  it('минимальный ввод — только заказ и позиция', () => {
    expect(IssueGiftFromOrderSchema.safeParse(base).success).toBe(true);
  });

  it('НОМИНАЛА во входе нет: он берётся из снимка позиции на сервере', () => {
    const parsed = IssueGiftFromOrderSchema.parse({ ...base, initialAmount: '999999.00' });
    expect('initialAmount' in parsed).toBe(false);
  });

  it('не-uuid заказа/позиции отвергается (защита от подмены)', () => {
    expect(IssueGiftFromOrderSchema.safeParse({ ...base, orderId: 'x' }).success).toBe(false);
    expect(IssueGiftFromOrderSchema.safeParse({ ...base, orderItemId: 'x' }).success).toBe(false);
  });
});
