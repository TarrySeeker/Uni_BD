import { describe, expect, it } from 'vitest';

import {
  ReviewSubmitSchema,
  ReviewStatusInputSchema,
  ReviewReplyInputSchema,
  ReviewListFilterSchema,
} from '@/lib/reviews/schemas';

/**
 * ЮНИТ (без БД): Zod-схемы отзывов (docs/24 §4). Rating 1..5 (не 0, не >5, не
 * дробный); длины author/body; productId uuid; anti-tamper (нет status/customerId
 * во входе submit); фильтр модерации.
 */
const PID = '11111111-1111-4111-8111-111111111111';

describe('reviews/schemas — submit (public)', () => {
  it('минимальный валидный вход', () => {
    const r = ReviewSubmitSchema.safeParse({
      productId: PID,
      authorName: 'Иван',
      body: 'Отличный платок',
      rating: 5,
    });
    expect(r.success).toBe(true);
  });

  it('rating 0 → ошибка (стандарт 1..5)', () => {
    expect(
      ReviewSubmitSchema.safeParse({ productId: PID, authorName: 'A', body: 'b', rating: 0 })
        .success,
    ).toBe(false);
  });

  it('rating 6 → ошибка', () => {
    expect(
      ReviewSubmitSchema.safeParse({ productId: PID, authorName: 'A', body: 'b', rating: 6 })
        .success,
    ).toBe(false);
  });

  it('rating дробный (4.5) → ошибка (только целое)', () => {
    expect(
      ReviewSubmitSchema.safeParse({ productId: PID, authorName: 'A', body: 'b', rating: 4.5 })
        .success,
    ).toBe(false);
  });

  it('пустой body → ошибка', () => {
    expect(
      ReviewSubmitSchema.safeParse({ productId: PID, authorName: 'A', body: '   ', rating: 4 })
        .success,
    ).toBe(false);
  });

  it('body длиннее 4000 → ошибка', () => {
    expect(
      ReviewSubmitSchema.safeParse({
        productId: PID,
        authorName: 'A',
        body: 'a'.repeat(4001),
        rating: 4,
      }).success,
    ).toBe(false);
  });

  it('productId не uuid → ошибка', () => {
    expect(
      ReviewSubmitSchema.safeParse({ productId: 'not-uuid', authorName: 'A', body: 'b', rating: 4 })
        .success,
    ).toBe(false);
  });

  it('anti-tamper: status/isVerified/customerId в теле ИГНОРИРУЮТСЯ (strip)', () => {
    const r = ReviewSubmitSchema.safeParse({
      productId: PID,
      authorName: 'A',
      body: 'b',
      rating: 4,
      status: 'approved',
      isVerified: true,
      customerId: '22222222-2222-4222-8222-222222222222',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('status' in r.data).toBe(false);
      expect('isVerified' in r.data).toBe(false);
      expect('customerId' in r.data).toBe(false);
    }
  });

  it('email опционален и валидируется', () => {
    expect(
      ReviewSubmitSchema.safeParse({
        productId: PID, authorName: 'A', body: 'b', rating: 4, email: 'a@b.io',
      }).success,
    ).toBe(true);
    expect(
      ReviewSubmitSchema.safeParse({
        productId: PID, authorName: 'A', body: 'b', rating: 4, email: 'bad',
      }).success,
    ).toBe(false);
  });
});

describe('reviews/schemas — модерация/ответ/фильтр', () => {
  it('status вход: только whitelist', () => {
    expect(ReviewStatusInputSchema.safeParse({ id: PID, status: 'approved' }).success).toBe(true);
    expect(ReviewStatusInputSchema.safeParse({ id: PID, status: 'spam' }).success).toBe(false);
  });

  it('reply вход: reply опционален/nullable + блок translations', () => {
    expect(
      ReviewReplyInputSchema.safeParse({ id: PID, reply: 'Спасибо!' }).success,
    ).toBe(true);
    expect(ReviewReplyInputSchema.safeParse({ id: PID, reply: null }).success).toBe(true);
    expect(
      ReviewReplyInputSchema.safeParse({
        id: PID,
        reply: 'Спасибо',
        translations: { en: { reply: 'Thanks' } },
      }).success,
    ).toBe(true);
  });

  it('фильтр списка: дефолты page/pageSize', () => {
    const r = ReviewListFilterSchema.parse({});
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });
});
