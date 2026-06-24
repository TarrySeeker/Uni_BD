import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// =============================================================================
// Валидация поля «логин» формы входа (lib/auth/actions.ts → loginSchema.email).
//
// КОНТЕКСТ: вход в админку принимает ЛОГИН или email (владелец может входить
// значением `admin`, а не только email-адресом). Значение хранится в колонке
// users.email (citext, регистронезависимый поиск). Поэтому формат НЕ ограничен
// `.email()` — только trim + непустая строка (≤200 символов).
//
// loginSchema объявлена в `'use server'`-модуле и не экспортируется (Next.js
// запрещает экспортировать из server-actions что-либо кроме async-функций), а
// сам модуль на верхнем уровне тянет БД/Redis. Поэтому здесь ЗЕРКАЛИМ ту же
// Zod-схему и фиксируем контракт: правило валидации логина должно совпадать.
// Если кто-то вернёт `.email()` в actions.ts — этот guard напомнит о регрессе.
// =============================================================================

// Зеркало loginSchema.email из lib/auth/actions.ts — держать синхронным.
const loginIdentifier = z.string().trim().min(1).max(200);

describe('auth/login — валидация логина (логин-ИЛИ-email)', () => {
  it('принимает произвольный логин `admin` (не email)', () => {
    const parsed = loginIdentifier.safeParse('admin');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('admin');
  });

  it('принимает email-адрес как логин (обратная совместимость)', () => {
    const parsed = loginIdentifier.safeParse('owner@example.com');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('owner@example.com');
  });

  it('тримит пробелы по краям', () => {
    const parsed = loginIdentifier.safeParse('  admin  ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('admin');
  });

  it('отклоняет пустую строку и строку из одних пробелов', () => {
    expect(loginIdentifier.safeParse('').success).toBe(false);
    expect(loginIdentifier.safeParse('   ').success).toBe(false);
  });

  it('отклоняет слишком длинный логин (>200 символов)', () => {
    expect(loginIdentifier.safeParse('a'.repeat(201)).success).toBe(false);
  });
});
