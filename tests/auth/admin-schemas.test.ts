import { describe, expect, it } from 'vitest';

import {
  UserCreateSchema,
  UserUpdateSchema,
  UserPasswordResetSchema,
  UserIdSchema,
  RoleCreateSchema,
  RoleUpdateSchema,
  RoleIdSchema,
} from '@/lib/auth/admin-schemas';

// ЮНИТ: Zod-схемы управления пользователями/ролями — всегда зелёные, без БД.

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

describe('UserCreateSchema', () => {
  it('валидный минимальный вход с дефолтами', () => {
    const parsed = UserCreateSchema.safeParse({
      email: 'user@example.com',
      password: 'secret12',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.displayName).toBe('');
      expect(parsed.data.roleIds).toEqual([]);
      expect(parsed.data.status).toBe('active');
    }
  });

  it('обрезает пробелы в email и имени', () => {
    const parsed = UserCreateSchema.safeParse({
      email: '  user@example.com  ',
      displayName: '  Иван  ',
      password: 'secret12',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe('user@example.com');
      expect(parsed.data.displayName).toBe('Иван');
    }
  });

  it('отклоняет плохой email', () => {
    expect(
      UserCreateSchema.safeParse({ email: 'not-an-email', password: 'secret12' }).success,
    ).toBe(false);
  });

  it('отклоняет короткий пароль (<8)', () => {
    expect(
      UserCreateSchema.safeParse({ email: 'user@example.com', password: 'short' }).success,
    ).toBe(false);
  });

  it('отклоняет недопустимый статус (invited на создании)', () => {
    expect(
      UserCreateSchema.safeParse({
        email: 'user@example.com',
        password: 'secret12',
        status: 'invited',
      }).success,
    ).toBe(false);
  });

  it('отклоняет роль с нечисловым/не-uuid id', () => {
    expect(
      UserCreateSchema.safeParse({
        email: 'user@example.com',
        password: 'secret12',
        roleIds: ['not-a-uuid'],
      }).success,
    ).toBe(false);
  });

  it('принимает массив корректных uuid ролей', () => {
    const parsed = UserCreateSchema.safeParse({
      email: 'user@example.com',
      password: 'secret12',
      roleIds: [UUID, UUID2],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('UserUpdateSchema', () => {
  it('требует id; прочие поля опциональны', () => {
    expect(UserUpdateSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(UserUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('принимает статус invited (в отличие от создания)', () => {
    expect(UserUpdateSchema.safeParse({ id: UUID, status: 'invited' }).success).toBe(true);
  });

  it('отклоняет неизвестный статус', () => {
    expect(UserUpdateSchema.safeParse({ id: UUID, status: 'banned' }).success).toBe(false);
  });

  it('отклоняет не-uuid id', () => {
    expect(UserUpdateSchema.safeParse({ id: '42' }).success).toBe(false);
  });
});

describe('UserPasswordResetSchema', () => {
  it('принимает id + пароль ≥8', () => {
    expect(UserPasswordResetSchema.safeParse({ id: UUID, password: 'secret12' }).success).toBe(true);
  });
  it('отклоняет короткий пароль', () => {
    expect(UserPasswordResetSchema.safeParse({ id: UUID, password: 'x' }).success).toBe(false);
  });
});

describe('UserIdSchema', () => {
  it('требует валидный uuid', () => {
    expect(UserIdSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(UserIdSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});

describe('RoleCreateSchema', () => {
  it('валидный вход с дефолтом прав []', () => {
    const parsed = RoleCreateSchema.safeParse({ code: 'support', title: 'Поддержка' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.permissionCodes).toEqual([]);
    }
  });

  it('принимает коды с цифрами/дефисом/подчёркиванием', () => {
    expect(RoleCreateSchema.safeParse({ code: 'a1_b-c', title: 'X' }).success).toBe(true);
  });

  it('отклоняет код с заглавными буквами', () => {
    expect(RoleCreateSchema.safeParse({ code: 'Support', title: 'X' }).success).toBe(false);
  });

  it('отклоняет код, начинающийся не с буквы', () => {
    expect(RoleCreateSchema.safeParse({ code: '1role', title: 'X' }).success).toBe(false);
    expect(RoleCreateSchema.safeParse({ code: '-role', title: 'X' }).success).toBe(false);
  });

  it('отклоняет слишком короткий код (1 символ)', () => {
    expect(RoleCreateSchema.safeParse({ code: 'a', title: 'X' }).success).toBe(false);
  });

  it('отклоняет пустое название', () => {
    expect(RoleCreateSchema.safeParse({ code: 'support', title: '   ' }).success).toBe(false);
  });
});

describe('RoleUpdateSchema', () => {
  it('требует id; title/права опциональны', () => {
    expect(RoleUpdateSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(RoleUpdateSchema.safeParse({ id: UUID, title: 'Новое' }).success).toBe(true);
  });
  it('НЕ принимает code (код роли неизменяем)', () => {
    const parsed = RoleUpdateSchema.safeParse({ id: UUID, code: 'changed' });
    // Лишнее поле игнорируется Zod-объектом: code не попадает в data.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('code' in parsed.data).toBe(false);
    }
  });
});

describe('RoleIdSchema', () => {
  it('требует валидный uuid', () => {
    expect(RoleIdSchema.safeParse({ id: UUID }).success).toBe(true);
    expect(RoleIdSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});
