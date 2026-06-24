import { afterAll, describe, expect, it } from 'vitest';
import {
  generateSessionId,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '@/lib/auth/session';

// =============================================================================
// (а) ЮНИТ-тесты — без БД и без next/headers, проходят ВСЕГДА.
//     Покрывают криптологику генерации id и константы.
//
//     ВАЖНО: импорт `@/lib/auth/session` на верхнем уровне НЕ должен тянуть
//     next/headers или next/navigation (иначе юнит-окружение упало бы на
//     импорте серверных API). Эти API изолированы внутри тел функций
//     getCurrentUser/requireUser и lib/auth/cookies.ts.
// =============================================================================
describe('auth/session — generateSessionId (юнит)', () => {
  // crypto.randomBytes(20) = 160 бит энтропии (> требуемых 120 бит).
  // base32 без паддинга кодирует 20 байт в 32 символа (ceil(160/5)).
  const EXPECTED_LENGTH = 32;
  const BASE32_ALPHABET = /^[a-z2-7]+$/;

  it('возвращает строку ожидаемой длины (≥120 бит энтропии)', () => {
    const id = generateSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBe(EXPECTED_LENGTH);
  });

  it('использует только валидные символы base32 (RFC 4648, нижний регистр без паддинга)', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateSessionId()).toMatch(BASE32_ALPHABET);
    }
  });

  it('генерирует уникальные id (коллизий на большой выборке нет)', () => {
    const count = 5000;
    const ids = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      ids.add(generateSessionId());
    }
    expect(ids.size).toBe(count);
  });

  it('энтропия достаточна: ≥120 бит (минимум по контракту §2.2)', () => {
    // 20 байт * 8 = 160 бит; длина base32-строки кодирует ≥120 бит.
    const id = generateSessionId();
    const entropyBits = id.length * 5; // base32: 5 бит на символ
    expect(entropyBits).toBeGreaterThanOrEqual(120);
  });
});

describe('auth/session — константы (юнит)', () => {
  it('SESSION_COOKIE_NAME = admik_session (§4.6)', () => {
    expect(SESSION_COOKIE_NAME).toBe('admik_session');
  });

  it('SESSION_TTL_MS — положительное число (окно жизни сессии)', () => {
    expect(typeof SESSION_TTL_MS).toBe('number');
    expect(SESSION_TTL_MS).toBeGreaterThan(0);
    // 30 дней по умолчанию (§4.6 — «например, 30 дней скользящего окна»).
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИОННЫЕ тесты — нужна живая БД. В этой среде PostgreSQL нет,
//     поэтому describe пропускается при отсутствии DATABASE_URL (skipIf).
//     В CI/проде с реальной БД (применённые миграции 0001..0004 + seed прав)
//     они проверяют create→validate→invalidate и инварианты GC/статуса.
// =============================================================================
const INTEGRATION_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)(
  'auth/session — create/validate/invalidate (интеграция)',
  () => {
    let sessionMod: typeof import('@/lib/auth/session');
    let sql: typeof import('@/lib/db/client').sql;
    let closeSql: typeof import('@/lib/db/client').closeSql;

    /** Создаёт тестового пользователя с заданным статусом, возвращает его id. */
    async function createUser(opts: {
      status?: 'active' | 'disabled';
      isOwner?: boolean;
      roleCodes?: string[];
    }): Promise<string> {
      const email = `sess-test-${generateSessionId()}@example.com`;
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, status, is_owner)
        VALUES (${email}, ${'$argon2id$dummy'}, ${opts.status ?? 'active'}, ${
        opts.isOwner ?? false
      })
        RETURNING id
      `;
      for (const code of opts.roleCodes ?? []) {
        await sql`
          INSERT INTO user_roles (user_id, role_id)
          SELECT ${user.id}, r.id FROM roles r WHERE r.code = ${code}
          ON CONFLICT DO NOTHING
        `;
      }
      return user.id;
    }

    async function ensureLoaded(): Promise<void> {
      if (!sessionMod) {
        sessionMod = await import('@/lib/auth/session');
        const dbMod = await import('@/lib/db/client');
        sql = dbMod.sql;
        closeSql = dbMod.closeSql;
      }
    }

    afterAll(async () => {
      if (closeSql) await closeSql();
    });

    it('create→validate возвращает AuthUser с эффективными правами', async () => {
      await ensureLoaded();
      const userId = await createUser({ roleCodes: ['manager'] });
      const session = await sessionMod.createSession(userId, {
        ip: '127.0.0.1',
        userAgent: 'vitest',
      });
      expect(session.id).toMatch(/^[a-z2-7]+$/);
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const authUser = await sessionMod.validateSession(session.id);
      expect(authUser).not.toBeNull();
      expect(authUser!.id).toBe(userId);
      expect(authUser!.isOwner).toBe(false);
      // manager имеет orders.read/write, catalog.read, cdek.manage, audit.read.
      expect(authUser!.permissions.has('orders.write')).toBe(true);
      expect(authUser!.permissions.has('users.manage')).toBe(false);
    });

    it('owner получает isOwner=true', async () => {
      await ensureLoaded();
      const userId = await createUser({ isOwner: true });
      const session = await sessionMod.createSession(userId, {});
      const authUser = await sessionMod.validateSession(session.id);
      expect(authUser!.isOwner).toBe(true);
    });

    it('просроченная сессия → null и удалена (ленивый GC)', async () => {
      await ensureLoaded();
      const userId = await createUser({});
      const session = await sessionMod.createSession(userId, {});
      // Принудительно просрочим сессию.
      await sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${session.id}`;

      const authUser = await sessionMod.validateSession(session.id);
      expect(authUser).toBeNull();

      const rows = await sql`SELECT 1 FROM sessions WHERE id = ${session.id}`;
      expect(rows.length).toBe(0); // GC удалил строку
    });

    it('status=disabled → null (доступ запрещён)', async () => {
      await ensureLoaded();
      const userId = await createUser({ status: 'disabled' });
      const session = await sessionMod.createSession(userId, {});
      const authUser = await sessionMod.validateSession(session.id);
      expect(authUser).toBeNull();
    });

    it('несуществующий id → null', async () => {
      await ensureLoaded();
      const authUser = await sessionMod.validateSession(generateSessionId());
      expect(authUser).toBeNull();
    });

    it('invalidateSession удаляет конкретную сессию', async () => {
      await ensureLoaded();
      const userId = await createUser({});
      const session = await sessionMod.createSession(userId, {});
      await sessionMod.invalidateSession(session.id);
      const authUser = await sessionMod.validateSession(session.id);
      expect(authUser).toBeNull();
    });

    it('invalidateUserSessions удаляет все сессии пользователя (ротация)', async () => {
      await ensureLoaded();
      const userId = await createUser({});
      const s1 = await sessionMod.createSession(userId, {});
      const s2 = await sessionMod.createSession(userId, {});
      await sessionMod.invalidateUserSessions(userId);
      expect(await sessionMod.validateSession(s1.id)).toBeNull();
      expect(await sessionMod.validateSession(s2.id)).toBeNull();
    });
  },
);
