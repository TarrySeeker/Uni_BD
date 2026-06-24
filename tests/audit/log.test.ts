import { afterAll, describe, expect, it } from 'vitest';
import { sanitize, writeAudit } from '@/lib/audit/log';

// =============================================================================
// (а) ЮНИТ-тесты — без БД, проходят ВСЕГДА.
//     Покрывают чистую логику санитизации чувствительных полей (§7.2):
//     пароли/токены/секреты НИКОГДА не должны попадать в аудит.
// =============================================================================
describe('audit/sanitize — вырезание чувствительных полей (юнит)', () => {
  it('null/undefined на входе → null', () => {
    expect(sanitize(undefined)).toBeNull();
    expect(sanitize()).toBeNull();
    expect(sanitize(null as unknown as Record<string, unknown>)).toBeNull();
  });

  it('вырезает password / password_hash / passwordHash на верхнем уровне', () => {
    const result = sanitize({
      id: 'u1',
      email: 'a@b.c',
      password: 'plain',
      password_hash: '$argon2id$...',
      passwordHash: '$argon2id$...',
    });
    expect(result).toEqual({ id: 'u1', email: 'a@b.c' });
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('password_hash');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('вырезает token / secret и подобные ключи без учёта регистра', () => {
    const result = sanitize({
      ok: 1,
      Token: 'abc',
      API_SECRET: 'xyz',
      sessionToken: 'qqq',
      refresh_token: 'rrr',
    });
    expect(result).toEqual({ ok: 1 });
  });

  it('рекурсивно чистит вложенные объекты', () => {
    const result = sanitize({
      id: 'u1',
      profile: {
        name: 'Иван',
        password: 'plain',
        meta: { token: 'deep', login: 'ivan' },
      },
    });
    expect(result).toEqual({
      id: 'u1',
      profile: {
        name: 'Иван',
        meta: { login: 'ivan' },
      },
    });
  });

  it('целиком отбрасывает ключ-контейнер секретов (credentials)', () => {
    const result = sanitize({
      id: 'u1',
      credentials: { login: 'ivan', token: 'deep' },
    });
    expect(result).toEqual({ id: 'u1' });
  });

  it('чистит объекты внутри массивов', () => {
    const result = sanitize({
      users: [
        { id: 'u1', password: 'p1' },
        { id: 'u2', token: 't2' },
      ],
    });
    expect(result).toEqual({
      users: [{ id: 'u1' }, { id: 'u2' }],
    });
  });

  it('не трогает обычные поля и сохраняет типы значений', () => {
    const input = {
      id: 'u1',
      count: 42,
      active: true,
      nothing: null,
      tags: ['a', 'b'],
    };
    expect(sanitize(input)).toEqual(input);
  });

  it('не мутирует исходный объект', () => {
    const input = { id: 'u1', password: 'plain' };
    sanitize(input);
    expect(input).toHaveProperty('password', 'plain');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — требует реальной БД с накатанной 0004_audit.sql.
//     Локально пропускается (нет DATABASE_URL). Проверяет реальную запись и
//     то, что чувствительные поля не сохраняются в БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('audit/writeAudit — запись в БД (интеграция)', () => {
  let closeSql: () => Promise<void>;
  let sql: import('postgres').Sql;

  afterAll(async () => {
    if (closeSql) {
      await closeSql();
    }
  });

  it('вставляет строку с корректными actor/action/ip; password_hash не попадает в after', async () => {
    const mod = await import('@/lib/db/client');
    sql = mod.sql;
    closeSql = mod.closeSql;

    const action = `test.audit.${Date.now()}`;
    await writeAudit(
      {
        action,
        entityType: 'user',
        entityId: 'u-test',
        after: { id: 'u-test', email: 'x@y.z', password_hash: '$argon2id$SECRET' },
      },
      {
        actorUserId: undefined,
        actorEmail: 'actor@admik.local',
        ip: '203.0.113.10',
        userAgent: 'vitest',
      },
    );

    const [row] = await sql<
      {
        actor_email: string;
        action: string;
        ip: string;
        after_data: Record<string, unknown> | null;
      }[]
    >`SELECT actor_email, action, host(ip) AS ip, after_data
        FROM audit_log WHERE action = ${action} LIMIT 1`;

    expect(row).toBeTruthy();
    expect(row.actor_email).toBe('actor@admik.local');
    expect(row.action).toBe(action);
    expect(row.ip).toBe('203.0.113.10');
    expect(row.after_data).toEqual({ id: 'u-test', email: 'x@y.z' });
    expect(row.after_data).not.toHaveProperty('password_hash');
  });
});
