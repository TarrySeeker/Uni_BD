import { describe, it, expect } from 'vitest';
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  type PermissionCode,
  type SystemRoleCode,
} from '@/lib/auth/permissions';
import {
  type AuthUser,
  ForbiddenError,
  can,
  requirePermission,
  buildPermissionSet,
} from '@/lib/auth/rbac';

/** Хелпер: собирает AuthUser из определения системной роли по коду. */
function userWithRole(code: SystemRoleCode, isOwner = false): AuthUser {
  const role = SYSTEM_ROLES.find((r) => r.code === code);
  if (!role) throw new Error(`нет системной роли ${code}`);
  return {
    id: `user-${code}`,
    email: `${code}@example.com`,
    isOwner,
    permissions: buildPermissionSet([role]),
  };
}

const ALL_CODES: PermissionCode[] = ALL_PERMISSIONS.map((p) => p.code);

describe('auth/permissions — каталог', () => {
  it('каждый код права уникален', () => {
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });

  it('содержит все коды из контракта §5.2', () => {
    expect(new Set(ALL_CODES)).toEqual(
      new Set<PermissionCode>([
        'users.read',
        'users.manage',
        'roles.manage',
        'audit.read',
        'settings.manage',
        'catalog.read',
        'catalog.write',
        'orders.read',
        'orders.write',
        'cdek.manage',
        'cms.read',
        'cms.write',
      ]),
    );
  });

  it('права системных ролей ссылаются на существующие коды', () => {
    for (const role of SYSTEM_ROLES) {
      for (const perm of role.permissions) {
        expect(ALL_CODES).toContain(perm);
      }
    }
  });
});

describe('auth/rbac — матрица роль → право', () => {
  it('owner проходит любое право, включая отсутствующее в его наборе', () => {
    const owner = userWithRole('owner', true);
    // У роли owner набор прав пустой — проверяем короткое замыкание is_owner.
    expect(SYSTEM_ROLES.find((r) => r.code === 'owner')?.permissions).toEqual([]);
    for (const code of ALL_CODES) {
      expect(can(owner, code)).toBe(true);
    }
  });

  it('admin имеет users.manage и все прочие права', () => {
    const admin = userWithRole('admin');
    expect(can(admin, 'users.manage')).toBe(true);
    for (const code of ALL_CODES) {
      expect(can(admin, code)).toBe(true);
    }
  });

  it('manager имеет orders.write, но НЕ имеет users.manage', () => {
    const manager = userWithRole('manager');
    expect(can(manager, 'orders.write')).toBe(true);
    expect(can(manager, 'orders.read')).toBe(true);
    expect(can(manager, 'catalog.read')).toBe(true);
    expect(can(manager, 'cdek.manage')).toBe(true);
    expect(can(manager, 'audit.read')).toBe(true);

    expect(can(manager, 'users.manage')).toBe(false);
    expect(can(manager, 'users.read')).toBe(false);
    expect(can(manager, 'roles.manage')).toBe(false);
    expect(can(manager, 'catalog.write')).toBe(false);
    expect(can(manager, 'settings.manage')).toBe(false);
  });
});

describe('auth/rbac — requirePermission', () => {
  it('бросает ForbiddenError, если права нет', () => {
    const manager = userWithRole('manager');
    expect(() => requirePermission(manager, 'users.manage')).toThrow(
      ForbiddenError,
    );
  });

  it('ForbiddenError несёт статус 403, код FORBIDDEN и недостающее право', () => {
    const manager = userWithRole('manager');
    try {
      requirePermission(manager, 'users.manage');
      expect.unreachable('должно было бросить');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      const e = err as ForbiddenError;
      expect(e.status).toBe(403);
      expect(e.code).toBe('FORBIDDEN');
      expect(e.permission).toBe('users.manage');
    }
  });

  it('не бросает, если право есть', () => {
    const manager = userWithRole('manager');
    expect(() => requirePermission(manager, 'orders.write')).not.toThrow();
  });

  it('не бросает для owner на любом праве', () => {
    const owner = userWithRole('owner', true);
    for (const code of ALL_CODES) {
      expect(() => requirePermission(owner, code)).not.toThrow();
    }
  });
});

describe('auth/rbac — buildPermissionSet', () => {
  it('объединяет права нескольких ролей без дублей', () => {
    const set = buildPermissionSet([
      { permissions: ['orders.read', 'orders.write'] },
      { permissions: ['orders.write', 'catalog.read'] },
    ]);
    expect(set).toEqual(
      new Set<PermissionCode>(['orders.read', 'orders.write', 'catalog.read']),
    );
    expect(set.size).toBe(3);
  });

  it('пустой список ролей даёт пустое множество', () => {
    expect(buildPermissionSet([]).size).toBe(0);
  });

  it('объединение admin+manager равно правам admin (admin — надмножество)', () => {
    const admin = SYSTEM_ROLES.find((r) => r.code === 'admin')!;
    const manager = SYSTEM_ROLES.find((r) => r.code === 'manager')!;
    const set = buildPermissionSet([admin, manager]);
    expect(set.size).toBe(admin.permissions.length);
  });
});

describe('auth/rbac — can для owner', () => {
  it('can = true для любого PermissionCode', () => {
    const owner: AuthUser = {
      id: 'owner',
      email: 'owner@example.com',
      isOwner: true,
      permissions: new Set<PermissionCode>(),
    };
    for (const code of ALL_CODES) {
      expect(can(owner, code)).toBe(true);
    }
  });
});
