import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты входного гейта удаления каталога (аудит 2026-07-26, находка #9).
 * БЕЗ БД/Next.
 *
 * Удаление варианта каскадом уносит строку inventory (0010, ON DELETE CASCADE),
 * а вместе с ней — РЕЗЕРВ открытого заказа. order_items.variant_id при этом
 * становится NULL (0012, ON DELETE SET NULL), поэтому commitReservation при
 * переходе в «Отгружен» больше никогда не находит остаток → заказ навсегда
 * застревает в «Собран». Схему не меняем — закрываем на входе:
 *   1) блокируем строки inventory удаляемого варианта/товара (FOR UPDATE) —
 *      это сериализует нас с reserveUnit из createOrder (он UPDATE-ит ту же
 *      строку), т.е. закрывает гонку «заказ создаётся ровно в момент удаления»;
 *   2) reserved > 0 → отказ (есть живой резерв);
 *   3) есть незакрытый заказ на этот вариант/товар → отказ с номерами заказов.
 */

const H = vi.hoisted(() => {
  interface SqlCall {
    text: string;
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
    state.sqlCalls.push({ text, args });
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
  (sqlMock as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => unknown) => {
    state.beginCalls += 1;
    return cb(sqlMock);
  };

  return {
    state,
    sqlMock,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
    rebuildCacheMock: vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>),
    rebuildVariantCacheMock: vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>),
    storageDeleteMock: vi.fn(async (..._args: unknown[]) => {}),
  };
});

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('@/lib/config/settings', () => ({ isModuleEffectivelyEnabled: async () => true }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));
vi.mock('@/lib/catalog/cache', () => ({
  rebuildProductAttributesCache: H.rebuildCacheMock,
  rebuildVariantAttributesCache: H.rebuildVariantCacheMock,
}));
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({ put: vi.fn(), delete: H.storageDeleteMock }),
}));
vi.mock('@/lib/storage/validate', () => ({ validateUpload: vi.fn() }));
vi.mock('@/lib/storage/image', () => ({ generatePreviews: vi.fn() }));

import { deleteVariant, deleteProduct } from '@/lib/catalog/actions';
import { OPEN_ORDER_STATUSES } from '@/lib/orders/status';

function makeUser(perms: PermissionCode[]): AuthUser {
  return { id: 'u-1', email: 'o@shop.io', isOwner: false, permissions: new Set(perms) };
}

const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

function sqlText(): string {
  return H.state.sqlCalls.map((c) => c.text).join('||');
}
function findCall(match: string) {
  return H.state.sqlCalls.find((c) => c.text.includes(match));
}

beforeEach(() => {
  H.state.currentUser = makeUser(['catalog.write']);
  H.state.sqlCalls = [];
  H.state.sqlResponses = [];
  H.state.beginCalls = 0;
  H.sqlMock.mockClear();
  H.writeAuditSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deleteVariant — вариант в незакрытом заказе не удаляется', () => {
  it('открытый заказ → отказ с номерами заказов, DELETE не выполняется', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [{ id: 'inv-1', reserved: 1 }] },
      { match: 'FROM order_items', rows: [{ number: 'GA-2026-000007' }] },
    ];
    const res = await deleteVariant({ id: VARIANT_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('conflict');
      expect(res.message).toContain('GA-2026-000007');
    }
    expect(sqlText()).not.toContain('DELETE FROM product_variants');
    expect(H.writeAuditSpy).not.toHaveBeenCalled();
  });

  it('живой резерв без найденного заказа → тоже отказ (резерв нельзя терять молча)', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [{ id: 'inv-1', reserved: 2 }] },
      { match: 'FROM order_items', rows: [] },
    ];
    const res = await deleteVariant({ id: VARIANT_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('conflict');
    expect(sqlText()).not.toContain('DELETE FROM product_variants');
  });

  it('нет открытых заказов и резерва → удаляет; проверка и DELETE в ОДНОЙ транзакции с FOR UPDATE', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [{ id: 'inv-1', reserved: 0 }] },
      { match: 'FROM order_items', rows: [] },
      { match: 'DELETE FROM product_variants', rows: [{ id: VARIANT_ID, product_id: PRODUCT_ID }] },
    ];
    const res = await deleteVariant({ id: VARIANT_ID });
    expect(res.ok).toBe(true);
    expect(H.state.beginCalls).toBe(1);
    expect(findCall('FROM inventory')!.text).toContain('FOR UPDATE');
    expect(sqlText()).toContain('DELETE FROM product_variants');
    expect(H.writeAuditSpy).toHaveBeenCalledTimes(1);
  });

  it('гейт смотрит только на НЕЗАКРЫТЫЕ статусы (отгруженные заказы не мешают)', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [] },
      { match: 'FROM order_items', rows: [] },
      { match: 'DELETE FROM product_variants', rows: [{ id: VARIANT_ID, product_id: PRODUCT_ID }] },
    ];
    await deleteVariant({ id: VARIANT_ID });
    const probe = findCall('FROM order_items');
    expect(probe).toBeDefined();
    const statuses = probe!.args.find((a) => Array.isArray(a)) as string[] | undefined;
    expect(statuses).toBeDefined();
    expect(statuses).toEqual([...OPEN_ORDER_STATUSES]);
    expect(statuses).not.toContain('shipped');
    expect(statuses).not.toContain('cancelled');
  });

  it('несуществующий вариант → not_found (гейт не подменяет прежнее поведение)', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [] },
      { match: 'FROM order_items', rows: [] },
      { match: 'DELETE FROM product_variants', rows: [] },
    ];
    const res = await deleteVariant({ id: VARIANT_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });
});

describe('deleteProduct — товар в незакрытом заказе не удаляется', () => {
  it('открытый заказ → отказ, товар остаётся', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [{ id: 'inv-1', reserved: 1 }] },
      { match: 'FROM order_items', rows: [{ number: 'GA-2026-000009' }] },
    ];
    const res = await deleteProduct({ id: PRODUCT_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('conflict');
      expect(res.message).toContain('GA-2026-000009');
    }
    expect(sqlText()).not.toContain('DELETE FROM products');
  });

  it('чистый товар удаляется как раньше', async () => {
    H.state.sqlResponses = [
      { match: 'FROM inventory', rows: [] },
      { match: 'FROM order_items', rows: [] },
      { match: 'DELETE FROM products', rows: [{ id: PRODUCT_ID }] },
    ];
    const res = await deleteProduct({ id: PRODUCT_ID });
    expect(res.ok).toBe(true);
    expect(sqlText()).toContain('DELETE FROM products');
  });
});
