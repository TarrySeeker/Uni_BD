import { describe, it, expect } from 'vitest';
import { NewsletterInputSchema } from '@/lib/newsletter/schemas';

/** Тесты G-12 — валидация email подписки. */
describe('NewsletterInputSchema', () => {
  it('валидный email проходит', () => {
    expect(NewsletterInputSchema.safeParse({ email: 'i@e.ru' }).success).toBe(true);
  });
  it('невалидный/пустой email → ошибка', () => {
    expect(NewsletterInputSchema.safeParse({ email: 'нет-почты' }).success).toBe(false);
    expect(NewsletterInputSchema.safeParse({ email: '' }).success).toBe(false);
  });
  it('тримит email', () => {
    const r = NewsletterInputSchema.safeParse({ email: '  i@e.ru ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('i@e.ru');
  });
});
