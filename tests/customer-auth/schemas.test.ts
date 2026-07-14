import { describe, expect, it } from 'vitest';

import {
  RegisterSchema,
  LoginSchema,
  PasswordResetRequestSchema,
  PasswordResetConfirmSchema,
  ProfileUpdateSchema,
} from '@/lib/customer-auth/schemas';

/**
 * ЮНИТ — Zod-схемы customer-auth (docs/24 §6). Форма ввода: email нормализуется,
 * пароль 8..128, необязательные поля. Бизнес-инварианты (email занят, locale-
 * членство) — не здесь.
 */
describe('customer-auth/schemas', () => {
  describe('RegisterSchema', () => {
    it('нормализует email (trim + lower) и принимает валидный пароль', () => {
      const r = RegisterSchema.safeParse({
        email: '  User@Example.COM ',
        password: 'sup3rsecret',
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe('user@example.com');
    });

    it('отклоняет короткий пароль (<8)', () => {
      const r = RegisterSchema.safeParse({ email: 'a@b.io', password: 'short' });
      expect(r.success).toBe(false);
    });

    it('отклоняет слишком длинный пароль (>128)', () => {
      const r = RegisterSchema.safeParse({
        email: 'a@b.io',
        password: 'x'.repeat(129),
      });
      expect(r.success).toBe(false);
    });

    it('отклоняет некорректный email', () => {
      const r = RegisterSchema.safeParse({ email: 'not-an-email', password: 'longenough' });
      expect(r.success).toBe(false);
    });

    it('name и preferredLocale необязательны', () => {
      const r = RegisterSchema.safeParse({ email: 'a@b.io', password: 'longenough' });
      expect(r.success).toBe(true);
    });
  });

  describe('LoginSchema', () => {
    it('принимает любой непустой пароль (длина не проверяется на логине)', () => {
      const r = LoginSchema.safeParse({ email: 'a@b.io', password: 'x' });
      expect(r.success).toBe(true);
    });
    it('отклоняет пустой пароль', () => {
      const r = LoginSchema.safeParse({ email: 'a@b.io', password: '' });
      expect(r.success).toBe(false);
    });
  });

  describe('PasswordResetRequestSchema', () => {
    it('нормализует email', () => {
      const r = PasswordResetRequestSchema.safeParse({ email: 'A@B.IO' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe('a@b.io');
    });
  });

  describe('PasswordResetConfirmSchema', () => {
    it('требует token и пароль 8..128', () => {
      expect(
        PasswordResetConfirmSchema.safeParse({ token: 'abc', password: 'longenough' }).success,
      ).toBe(true);
      expect(
        PasswordResetConfirmSchema.safeParse({ token: '', password: 'longenough' }).success,
      ).toBe(false);
      expect(
        PasswordResetConfirmSchema.safeParse({ token: 'abc', password: 'short' }).success,
      ).toBe(false);
    });
  });

  describe('ProfileUpdateSchema', () => {
    it('требует хотя бы одно поле', () => {
      expect(ProfileUpdateSchema.safeParse({}).success).toBe(false);
      expect(ProfileUpdateSchema.safeParse({ name: 'Иван' }).success).toBe(true);
    });
  });
});
