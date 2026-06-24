import { describe, it, expect } from 'vitest';
import { LeadInputSchema } from '@/lib/leads/schemas';

/** Тесты G-09 — валидация заявки с витрины (anti-spam/anti-tamper). */
describe('LeadInputSchema', () => {
  it('валидная заявка проходит', () => {
    const r = LeadInputSchema.safeParse({ name: 'Иван', contact: 'i@e.ru', message: 'привет' });
    expect(r.success).toBe(true);
  });

  it('пустые поля → ошибка', () => {
    expect(LeadInputSchema.safeParse({ name: '', contact: 'x', message: 'y' }).success).toBe(false);
    expect(LeadInputSchema.safeParse({ name: 'a', contact: '', message: 'y' }).success).toBe(false);
    expect(LeadInputSchema.safeParse({ name: 'a', contact: 'x', message: '' }).success).toBe(false);
  });

  it('тримит и ограничивает длину', () => {
    const r = LeadInputSchema.safeParse({ name: '  Иван  ', contact: 'i@e.ru', message: 'm' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe('Иван');
    expect(LeadInputSchema.safeParse({ name: 'a'.repeat(201), contact: 'x', message: 'y' }).success).toBe(false);
    expect(LeadInputSchema.safeParse({ name: 'a', contact: 'x', message: 'm'.repeat(5001) }).success).toBe(false);
  });
});
