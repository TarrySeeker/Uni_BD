import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты раздела «Подписчики» (устранение тупика владельца, аудит dead-button):
 *   (а) формирование CSV для экспорта адресов (subscribersToCsv) — чистая функция,
 *       проверяем RFC 4180-экранирование и анти-CSV-инъекцию (=,+,-,@);
 *   (б) Server Action отписки (unsubscribeSubscriber) — guard orders.write → Zod →
 *       guarded UPDATE → revalidate → audit. БД/Next изолированы vi.mock-ами
 *       (образец tests/orders/actions.test.ts).
 */

// === (а) CSV — чистая функция, без моков ====================================

import { subscribersToCsv, CSV_MIME } from '@/lib/newsletter/csv';

describe('subscribersToCsv (экспорт адресов)', () => {
  it('заголовок + строки в порядке email,status,created_at', () => {
    const csv = subscribersToCsv([
      { email: 'a@e.ru', status: 'active', created_at: new Date('2026-06-01T10:00:00Z') },
      { email: 'b@e.ru', status: 'unsubscribed', created_at: new Date('2026-06-02T11:30:00Z') },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('email,status,created_at');
    expect(lines[1]).toBe('a@e.ru,active,2026-06-01T10:00:00.000Z');
    expect(lines[2]).toBe('b@e.ru,unsubscribed,2026-06-02T11:30:00.000Z');
  });

  it('пустой список → только заголовок', () => {
    expect(subscribersToCsv([])).toBe('email,status,created_at');
  });

  it('экранирует запятые и кавычки (RFC 4180)', () => {
    // Email с запятой/кавычкой искусственный, но поле должно быть в кавычках,
    // а внутренние кавычки — удвоены. Гарантирует, что список не «съедет».
    const csv = subscribersToCsv([
      { email: 'we"ird, name@e.ru', status: 'active', created_at: new Date('2026-06-01T00:00:00Z') },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"we""ird, name@e.ru",active,2026-06-01T00:00:00.000Z');
  });

  it('экранирует перенос строки в значении', () => {
    const csv = subscribersToCsv([
      { email: 'a\nb@e.ru', status: 'active', created_at: new Date('2026-06-01T00:00:00Z') },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"a\nb@e.ru",active,2026-06-01T00:00:00.000Z');
  });

  it('анти-CSV-инъекция: значение, начинающееся с =,+,-,@, префиксуется апострофом', () => {
    // Если email начинается с формульного символа, Excel/Sheets исполнят формулу.
    // Защита — ведущий апостроф; т.к. значение изменено и содержит апостроф,
    // оно квотируется целиком (поле не съезжает).
    const csv = subscribersToCsv([
      { email: '=cmd@e.ru', status: 'active', created_at: new Date('2026-06-01T00:00:00Z') },
    ]);
    expect(csv.split('\r\n')[1]).toBe('"\'=cmd@e.ru",active,2026-06-01T00:00:00.000Z');
  });

  it('CSV_MIME — text/csv с charset', () => {
    expect(CSV_MIME).toContain('text/csv');
  });
});

// === (б) Server Action отписки — с моками (образец orders) ===================

const H = vi.hoisted(() => {
  const state = {
    currentUser: null as AuthUser | null,
    /** Очередь результатов для tagged-template sql (каждый вызов снимает один). */
    sqlQueue: [] as unknown[][],
    /** Лог sql-вызовов: статические куски шаблона + интерполированные аргументы. */
    sqlCalls: [] as { strings: string[]; args: unknown[] }[],
  };
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    state.sqlCalls.push({ strings: Array.from(strings ?? []), args });
    const next = state.sqlQueue.length > 0 ? state.sqlQueue.shift()! : [];
    return Promise.resolve(next);
  });
  return {
    state,
    sqlMock,
    writeAuditSpy: vi.fn(async (..._a: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
  };
});

const { sqlMock, writeAuditSpy, getCurrentUserMock } = H;

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));

import { unsubscribeSubscriber } from '@/lib/newsletter/actions';

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'u@shop.io', isOwner, permissions: new Set<PermissionCode>(perms) };
}

const UUID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  H.state.currentUser = makeUser(['orders.read', 'orders.write']);
  H.state.sqlQueue = [];
  H.state.sqlCalls = [];
  sqlMock.mockClear();
  writeAuditSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('unsubscribeSubscriber (отписка)', () => {
  it('не аутентифицирован → unauthorized', async () => {
    H.state.currentUser = null;
    const res = await unsubscribeSubscriber({ id: UUID });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('нет orders.write (только orders.read) → forbidden', async () => {
    H.state.currentUser = makeUser(['orders.read']);
    const res = await unsubscribeSubscriber({ id: UUID });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('owner проходит guard', async () => {
    H.state.currentUser = makeUser([], true);
    H.state.sqlQueue = [[{ id: UUID, email: 'a@e.ru', status: 'unsubscribed' }]];
    const res = await unsubscribeSubscriber({ id: UUID });
    expect(res.ok).toBe(true);
  });

  it('невалидный id (не uuid) → validation', async () => {
    const res = await unsubscribeSubscriber({ id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
  });

  it('успех: UPDATE status=unsubscribed (guarded AND status=active), audit, без падения', async () => {
    H.state.sqlQueue = [[{ id: UUID, email: 'a@e.ru', status: 'unsubscribed' }]];
    const res = await unsubscribeSubscriber({ id: UUID });
    expect(res.ok).toBe(true);

    // UPDATE несёт целевой статус и guard «active» (повторная отписка — no-op).
    const text = H.state.sqlCalls.map((c) => c.strings.join('|')).join('||');
    expect(text).toContain('UPDATE newsletter_subscribers');
    expect(text).toContain("status = 'unsubscribed'");
    expect(text).toContain("status = 'active'"); // guard: отписываем только активных
    expect(H.state.sqlCalls.some((c) => c.args.includes(UUID))).toBe(true);

    // audit-запись сформирована с newsletter.unsubscribe + entityId.
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const [entry] = writeAuditSpy.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({
      action: 'newsletter.unsubscribe',
      entityType: 'newsletter_subscriber',
      entityId: UUID,
    });
  });

  it('подписчик не найден / уже отписан (0 строк) → validation + message, audit НЕ пишется', async () => {
    H.state.sqlQueue = [[]]; // guarded UPDATE вернул 0 строк
    const res = await unsubscribeSubscriber({ id: UUID });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toBeTruthy();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});
