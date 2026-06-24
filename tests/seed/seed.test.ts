import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@/lib/auth/permissions';

/**
 * Тесты задачи 1.7 — seed владельца + интеграция в init-shop (docs/04 §4.2).
 *
 * ЮНИТ (всегда): статически проверяем, что сидовые SQL-файлы и owner.mjs
 *   соответствуют контракту-источнику (ALL_PERMISSIONS / SYSTEM_ROLES) и
 *   идемпотентны (ON CONFLICT DO NOTHING, проверка существования владельца).
 * ИНТЕГРАЦИЯ (skipIf без DATABASE_URL): двойной накат seed не плодит дублей.
 */

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const permissionsSql = readFileSync(root('db/seed/permissions.sql'), 'utf8');
const rolesSql = readFileSync(root('db/seed/roles.sql'), 'utf8');
const ownerMjs = readFileSync(root('db/seed/owner.mjs'), 'utf8');

describe('seed/permissions.sql', () => {
  it('содержит INSERT во все коды прав из ALL_PERMISSIONS', () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(
        permissionsSql,
        `в permissions.sql отсутствует код права ${perm.code}`,
      ).toContain(`'${perm.code}'`);
    }
  });

  it('идемпотентен: использует ON CONFLICT ... DO NOTHING', () => {
    expect(permissionsSql.toUpperCase()).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });

  it('наполняет таблицу permissions', () => {
    expect(permissionsSql.toLowerCase()).toContain('insert into permissions');
  });
});

describe('seed/roles.sql', () => {
  it('содержит все системные роли owner/admin/manager', () => {
    for (const role of SYSTEM_ROLES) {
      expect(
        rolesSql,
        `в roles.sql отсутствует роль ${role.code}`,
      ).toContain(`'${role.code}'`);
    }
  });

  it('помечает роли системными (is_system = true)', () => {
    expect(rolesSql.toLowerCase()).toContain('is_system');
    expect(rolesSql.toLowerCase()).toContain('true');
  });

  it('идемпотентен: ON CONFLICT ... DO NOTHING', () => {
    expect(rolesSql.toUpperCase()).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });

  it('привязывает права admin и manager согласно SYSTEM_ROLES', () => {
    const admin = SYSTEM_ROLES.find((r) => r.code === 'admin');
    const manager = SYSTEM_ROLES.find((r) => r.code === 'manager');
    expect(admin).toBeDefined();
    expect(manager).toBeDefined();
    // admin — все права; manager — свой операционный набор.
    for (const code of admin!.permissions) {
      expect(rolesSql, `admin: нет привязки ${code}`).toContain(`'${code}'`);
    }
    for (const code of manager!.permissions) {
      expect(rolesSql, `manager: нет привязки ${code}`).toContain(`'${code}'`);
    }
  });

  it('owner не получает явных привязок прав (короткое замыкание is_owner)', () => {
    const owner = SYSTEM_ROLES.find((r) => r.code === 'owner');
    expect(owner!.permissions).toEqual([]);
  });

  it('наполняет role_permissions через подзапросы по кодам', () => {
    expect(rolesSql.toLowerCase()).toContain('role_permissions');
  });
});

describe('seed/owner.mjs', () => {
  it('файл существует', () => {
    expect(existsSync(root('db/seed/owner.mjs'))).toBe(true);
  });

  it('читает OWNER_EMAIL / OWNER_PASSWORD из окружения', () => {
    expect(ownerMjs).toContain('OWNER_EMAIL');
    expect(ownerMjs).toContain('OWNER_PASSWORD');
  });

  it('хеширует пароль через argon2', () => {
    expect(ownerMjs).toContain('@node-rs/argon2');
  });

  it('идемпотентен: проверяет существование пользователя по email', () => {
    // Либо явная проверка SELECT по email, либо ON CONFLICT — что-то из этого.
    const lower = ownerMjs.toLowerCase();
    const hasExistenceCheck =
      lower.includes('select') && lower.includes('users');
    const hasOnConflict = /on conflict/.test(lower);
    expect(hasExistenceCheck || hasOnConflict).toBe(true);
  });

  it('создаёт владельца с is_owner = true и статусом active', () => {
    expect(ownerMjs).toContain('is_owner');
    expect(ownerMjs.toLowerCase()).toContain('active');
  });

  it('привязывает владельца к системной роли owner', () => {
    expect(ownerMjs).toContain('user_roles');
    expect(ownerMjs).toContain("'owner'");
  });

  it('генерирует случайный пароль через node:crypto при отсутствии OWNER_PASSWORD', () => {
    expect(ownerMjs).toContain('node:crypto');
  });
});

// ---------------------------------------------------------------------------
// Интеграция: повторный накат seed не плодит дублей. Требует реальной БД.
// ---------------------------------------------------------------------------
const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('seed (интеграция, требует DATABASE_URL)', () => {
  let sql: import('postgres').Sql;

  beforeAll(async () => {
    const postgres = (await import('postgres')).default;
    sql = postgres(DB_URL as string);
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат permissions.sql не плодит дублей', async () => {
    await sql.unsafe(permissionsSql);
    await sql.unsafe(permissionsSql);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM permissions`;
    expect(rows[0].n).toBe(ALL_PERMISSIONS.length);
  });

  it('двойной накат roles.sql не плодит дублей ролей', async () => {
    await sql.unsafe(permissionsSql);
    await sql.unsafe(rolesSql);
    await sql.unsafe(rolesSql);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM roles WHERE code IN ('owner','admin','manager')`;
    expect(rows[0].n).toBe(3);
  });
});
