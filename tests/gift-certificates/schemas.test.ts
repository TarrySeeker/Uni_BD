import { describe, it, expect } from 'vitest';

import {
  giftCodeSchema,
  giftFaceValueSchema,
  IssueGiftCertificateSchema,
  UpdateGiftCertificateSchema,
  SetGiftStatusSchema,
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
