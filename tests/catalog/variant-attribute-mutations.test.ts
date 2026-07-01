import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты Server Actions каталога reorderVariant (C12) и deleteAttributeValue
 * (C14) — поведение реального хендлера БЕЗ БД/Next. Паттерн заимствован у
 * move-category-toctou.test.ts: `sql` — tagged-template-спай (пишет вызовы в
 * state.sqlCalls, отдаёт ответы по подстроке шаблона); `sql.begin(cb)` → cb(спай);
 * auth/cache/headers/audit/settings — замоканы. Утверждаем формируемый SQL
 * (склейку статических кусков и интерполированные аргументы), порядок запросов,
 * атомарность (begin) и эмиссию аудита/CatalogError.
 */

const H = vi.hoisted(() => {
  interface SqlCall {
    text: string;
    strings: string[];
    args: unknown[];
  }
  interface QueuedResult {
    match: string;
    rows?: unknown[];
    times?: number;
  }
  const state = {
    currentUser: null as AuthUser | null,
    sqlCalls: [] as SqlCall[],
    sqlResponses: [] as QueuedResult[],
    beginCalls: 0,
  };

  function templateText(strings: TemplateStringsArray | string[]): string {
    return Array.from(strings).join('?');
  }

  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = templateText(strings);
    state.sqlCalls.push({ text, strings: Array.from(strings), args });
    for (const r of state.sqlResponses) {
      if (text.includes(r.match)) {
        if (typeof r.times === 'number') {
          if (r.times <= 0) continue;
          r.times -= 1;
        }
        return Promise.resolve(r.rows ?? []);
      }
    }
    return Promise.resolve([] as unknown[]);
  });
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  (sqlMock as unknown as { begin: unknown }).begin = async (
    cb: (tx: unknown) => unknown,
  ) => {
    state.beginCalls += 1;
    return cb(sqlMock);
  };

  return {
    state,
    sqlMock,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
  };
});

const { sqlMock } = H;

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('@/lib/config/settings', () => ({ isModuleEffectivelyEnabled: async () => true }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));

// Импорт actions ПОСЛЕ моков.
import { reorderVariant, deleteAttributeValue } from '@/lib/catalog/actions';

function makeOwner(): AuthUser {
  return {
    id: 'u-1',
    email: 'owner@shop.io',
    isOwner: true,
    permissions: new Set<PermissionCode>(),
  };
}

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VAR_A = '22222222-2222-4222-8222-222222222222';
const VAR_B = '33333333-3333-4333-8333-333333333333';
const VAR_C = '44444444-4444-4444-8444-444444444444';
const ATTR_VALUE = '55555555-5555-4555-8555-555555555555';

function findCalls(match: string) {
  return H.state.sqlCalls.filter((c) => c.text.includes(match));
}
function indexOfCall(match: string): number {
  return H.state.sqlCalls.findIndex((c) => c.text.includes(match));
}

beforeEach(() => {
  H.state.currentUser = makeOwner();
  H.state.sqlCalls = [];
  H.state.sqlResponses = [];
  H.state.beginCalls = 0;
  sqlMock.mockClear();
  H.writeAuditSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// C12 — reorderVariant: индекс id → sort, в ОДНОЙ транзакции, скоуп product_id.
// =============================================================================
describe('C12 — reorderVariant round-trip', () => {
  it('order [C,A,B] → три UPDATE sort=0/1/2 с нужными id, в одной транзакции', async () => {
    const res = await reorderVariant({ productId: PRODUCT, order: [VAR_C, VAR_A, VAR_B] });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // Вся перестановка — в одной транзакции (атомарность как у reorderMedia).
    expect(H.state.beginCalls).toBe(1);

    const updates = findCalls('UPDATE product_variants');
    expect(updates).toHaveLength(3);
    // Аргументы шаблона `SET sort = ${i} WHERE id = ${order[i]} AND product_id = ${productId}`.
    expect(updates[0]!.args).toEqual([0, VAR_C, PRODUCT]);
    expect(updates[1]!.args).toEqual([1, VAR_A, PRODUCT]);
    expect(updates[2]!.args).toEqual([2, VAR_B, PRODUCT]);
    // Каждый UPDATE скоупится product_id (чужой вариант не затрагивается).
    for (const u of updates) {
      expect(u.text).toContain('product_id =');
    }
  });

  it('эмитит аудит catalog.variant.reorder', async () => {
    await reorderVariant({ productId: PRODUCT, order: [VAR_A, VAR_B] });
    expect(H.writeAuditSpy).toHaveBeenCalledTimes(1);
    const entry = H.writeAuditSpy.mock.calls[0]![0] as { action: string; entityType: string };
    expect(entry.action).toBe('catalog.variant.reorder');
    expect(entry.entityType).toBe('product');
  });
});

// =============================================================================
// C14 — deleteAttributeValue: предпроверка использования → DELETE ... RETURNING.
// =============================================================================
describe('C14 — deleteAttributeValue', () => {
  it('значение используется товарами → conflict (validation) с понятным текстом, DELETE НЕ выполняется', async () => {
    H.state.sqlResponses.push({ match: 'FROM product_attributes', rows: [{ one: 1 }] });

    const res = await deleteAttributeValue({ id: ATTR_VALUE });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // CatalogError(PublicActionError) → пайплайн маппит в 'validation' + message.
      expect(res.error).toBe('validation');
      expect(res.message).toContain('используется');
    }
    // КЛЮЧЕВОЕ: при конфликте удаление не должно произойти.
    expect(findCalls('DELETE FROM attribute_values')).toHaveLength(0);
    // Предпроверка должна идти ДО (и вместо) удаления.
    expect(indexOfCall('FROM product_attributes')).toBeGreaterThanOrEqual(0);
  });

  it('значение свободно → DELETE ... RETURNING, ok, аудит catalog.attribute_value.delete', async () => {
    H.state.sqlResponses.push({ match: 'FROM product_attributes', rows: [] });
    H.state.sqlResponses.push({ match: 'DELETE FROM attribute_values', rows: [{ id: ATTR_VALUE }] });

    const res = await deleteAttributeValue({ id: ATTR_VALUE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) expect(res.data.id).toBe(ATTR_VALUE);

    const del = findCalls('DELETE FROM attribute_values');
    expect(del).toHaveLength(1);
    expect(del[0]!.text).toContain('RETURNING id');
    expect(del[0]!.args).toEqual([ATTR_VALUE]);

    expect(H.writeAuditSpy).toHaveBeenCalledTimes(1);
    const entry = H.writeAuditSpy.mock.calls[0]![0] as { action: string };
    expect(entry.action).toBe('catalog.attribute_value.delete');
  });

  it('значение не найдено (DELETE вернул пусто) → not_found (validation)', async () => {
    H.state.sqlResponses.push({ match: 'FROM product_attributes', rows: [] });
    H.state.sqlResponses.push({ match: 'DELETE FROM attribute_values', rows: [] });

    const res = await deleteAttributeValue({ id: ATTR_VALUE });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('validation');
      expect(res.message).toContain('не найдено');
    }
  });
});
