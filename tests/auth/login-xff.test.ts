import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * РЕГРЕСС login() на кривой/подделанный X-Forwarded-For (major-баг reliability).
 *
 * До фикса getRequestMeta возвращал X-Forwarded-For ДОСЛОВНО, и сырая строка
 * шла в createSession → INSERT в колонку `inet` → Postgres падал на касте →
 * логин был сломан для пользователя (атакующий мог подделать заголовок, но и
 * обычный битый прокси-заголовок ломал вход).
 *
 * После фикса getRequestMeta валидирует IP (normalizeClientIp): мусорный
 * X-Forwarded-For → ip=undefined → createSession получает undefined → слой БД
 * пишет null (sessions.ip nullable) → логин НЕ падает.
 *
 * Все серверные зависимости замоканы → тест не трогает БД/Next/argon2.
 */

const h = vi.hoisted(() => ({
  // Управляемые заголовки запроса.
  reqHeaders: new Map<string, string>(),
  // Захваченный meta, переданный в createSession.
  createSessionArg: { value: undefined as undefined | { ip?: string; userAgent?: string } },
  // sql: первый вызов (SELECT user) отдаёт активного пользователя; остальное — [].
  sqlResults: [] as unknown[][],
}));

function sqlImpl(_strings?: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
  return Promise.resolve(h.sqlResults.length > 0 ? (h.sqlResults.shift() as unknown[]) : []);
}

vi.mock('@/lib/db/client', () => ({ sql: sqlImpl }));

vi.mock('@/lib/auth/session', () => ({
  SESSION_COOKIE_NAME: 'admik_session',
  createSession: vi.fn(async (_userId: string, meta: { ip?: string; userAgent?: string }) => {
    h.createSessionArg.value = meta;
    return { id: 'sess-1', expiresAt: new Date(Date.now() + 1000) };
  }),
  invalidateSession: vi.fn(async () => {}),
  invalidateUserSessions: vi.fn(async () => {}),
  requireUser: vi.fn(async () => ({ id: 'u-1', email: 'a@b.c' })),
}));

vi.mock('@/lib/auth/cookies', () => ({
  setSessionCookie: vi.fn(async () => {}),
  clearSessionCookie: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth/password', () => ({
  verifyPassword: vi.fn(async () => true),
  verifyDummy: vi.fn(async () => false),
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  checkLoginRate: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  registerLoginFailure: vi.fn(async () => {}),
  resetLoginFailures: vi.fn(async () => {}),
}));

vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => {}) }));

// next/headers — отдаёт управляемые заголовки.
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: (k: string) => h.reqHeaders.get(k.toLowerCase()) ?? null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

// next/navigation — redirect() бросает сентинел (как настоящий Next).
const REDIRECT_SENTINEL = 'NEXT_REDIRECT';
vi.mock('next/navigation', () => ({
  redirect: vi.fn((_path: string) => {
    throw new Error(REDIRECT_SENTINEL);
  }),
}));

import { login } from '@/lib/auth/actions';

beforeEach(() => {
  h.reqHeaders.clear();
  h.createSessionArg.value = undefined;
  // SELECT user → активный пользователь с корректным хешем.
  h.sqlResults = [
    [{ id: 'u-1', email: 'admin', password_hash: 'hash', status: 'active' }],
  ];
});

describe('login() — устойчивость к кривому X-Forwarded-For', () => {
  it('garbage X-Forwarded-For → login доходит до redirect (не падает), createSession.ip = undefined', async () => {
    h.reqHeaders.set('x-forwarded-for', 'garbage');

    // Успешный логин завершается redirect('/admin') → бросок сентинела.
    await expect(login({ email: 'admin', password: 'secret' })).rejects.toThrow(
      REDIRECT_SENTINEL,
    );

    // КЛЮЧЕВОЕ: createSession получил undefined ip (а не строку 'garbage'),
    // т.е. в колонку inet уйдёт null и каст не упадёт.
    expect(h.createSessionArg.value).toBeDefined();
    expect(h.createSessionArg.value?.ip).toBeUndefined();
  });

  it('валидный X-Forwarded-For "203.0.113.7, 10.0.0.1" → createSession.ip = "203.0.113.7"', async () => {
    h.reqHeaders.set('x-forwarded-for', '203.0.113.7, 10.0.0.1');

    await expect(login({ email: 'admin', password: 'secret' })).rejects.toThrow(
      REDIRECT_SENTINEL,
    );

    expect(h.createSessionArg.value?.ip).toBe('203.0.113.7');
  });
});
