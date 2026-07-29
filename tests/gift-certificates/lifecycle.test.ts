import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { DEFAULT_LOCALE_CONFIG } from '@/lib/i18n';
import {
  createGiftActions,
  reviveStatusAfterTopUp,
  type GiftActionDeps,
  type UpdateFieldsInput,
} from '@/lib/gift-certificates/actions';
import { expiredGiftStatus, GIFT_EXPIRE_TASK } from '@/lib/gift-certificates/lifecycle';
import type { GiftCertificate } from '@/lib/gift-certificates/types';
import type { GiftIssueSourceRow } from '@/lib/gift-certificates/repository';

/**
 * ЖИЗНЕННЫЙ ЦИКЛ сертификата — аудит-находки №10 (пополнение исчерпанного),
 * минор №3 (статус 'expired' никогда не выставлялся).
 *
 * Всё считается ЧИСТЫМИ функциями (без БД/Next), чтобы правило «когда код снова
 * работает» жило в одном месте и совпадало у SQL-пути (releaseGiftTx) и у
 * пополнения из админки.
 */

function makeUser(perms: PermissionCode[]): AuthUser {
  return { id: 'u-1', email: 'owner@shop.io', isOwner: false, permissions: new Set(perms) };
}

function makeActionDeps(user: AuthUser | null) {
  const writeAudit = vi.fn(async (_entry: { action: string }, _ctx?: unknown) => {});
  const revalidate = vi.fn(async (_path: string) => {});
  const actionDeps: ActionDeps = {
    getCurrentUser: vi.fn(async () => user),
    writeAudit,
    revalidate,
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
  return { actionDeps, writeAudit, revalidate };
}

function makeCert(over: Partial<GiftCertificate> = {}): GiftCertificate {
  return {
    id: 'c1',
    code: 'GIFT',
    name: '',
    description: null,
    terms: null,
    initialAmount: '500.00',
    spentTotal: '500.00',
    remaining: '0.00',
    currency: 'RUB',
    status: 'depleted',
    validUntil: null,
    translations: {},
    comment: '',
    purchaser: { name: null, email: null, phone: null },
    purchaserCustomerId: null,
    recipient: { name: null, email: null, phone: null },
    issuedOrderId: null,
    issuedOrderItemId: null,
    issueSource: 'manual',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

function makeSource(over: Partial<GiftIssueSourceRow> = {}): GiftIssueSourceRow {
  return {
    orderId: ORDER_ID,
    orderNumber: 'CR-2026-000042',
    currency: 'RUB',
    customerId: null,
    customerName: 'Пётр Гость',
    customerEmail: 'guest@shop.io',
    customerPhone: '+79990000000',
    paymentStatus: 'paid',
    status: 'paid',
    paidAt: new Date('2026-01-01T00:00:00.000Z'),
    giftCertificateId: null,
    item: {
      id: ITEM_ID,
      nameSnapshot: 'Подарочный сертификат 5000',
      skuSnapshot: 'CERT-5000',
      attributesSnapshot: { gift_certificate: true },
      unitPrice: '5000.00',
      quantity: 1,
      lineTotal: '5000.00',
    },
    ...over,
  };
}

function build(user: AuthUser | null, over: Partial<GiftActionDeps> = {}) {
  const a = makeActionDeps(user);
  const repo = {
    insertGiftCertificate: vi.fn(async (row) => makeCert({ id: 'new-id', code: row.code })),
    getGiftCertificateById: vi.fn(async () => makeCert()),
    updateGiftStatus: vi.fn(async () => true),
    updateGiftFields: vi.fn(async (_input: UpdateFieldsInput) => makeCert()),
    getOrderItemForGiftIssue: vi.fn(async () => makeSource()),
  };
  const deps: GiftActionDeps = {
    actionDeps: a.actionDeps,
    isOrdersEnabled: vi.fn(async () => true),
    getLocaleConfig: vi.fn(async () => DEFAULT_LOCALE_CONFIG),
    getGiftSettings: vi.fn(async () => ({
      autoIssue: true,
      validDays: 0,
      categorySlugs: [],
      allowIssueOnGiftPaidOrder: true,
    })),
    randomCode: vi.fn(() => 'RAND-OMCO-DE00-0000'),
    ...repo,
    ...over,
  };
  return { actions: createGiftActions(deps), repo, deps, ...a };
}

const VALID_ID = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// №10 — пополнение исчерпанного сертификата возвращает его в работу.
// ---------------------------------------------------------------------------

describe('находка №10 — reviveStatusAfterTopUp (чистое правило)', () => {
  it('depleted + номинал вырос выше потраченного → снова active', () => {
    expect(
      reviveStatusAfterTopUp({ status: 'depleted', initialAmount: '1000.00', spentTotal: '500.00' }),
    ).toBe('active');
  });

  it('depleted, но остаток всё ещё 0 → остаётся depleted', () => {
    expect(
      reviveStatusAfterTopUp({ status: 'depleted', initialAmount: '500.00', spentTotal: '500.00' }),
    ).toBe('depleted');
  });

  it('🔴 disabled НЕ оживает пополнением: отключение — осознанное решение оператора', () => {
    expect(
      reviveStatusAfterTopUp({ status: 'disabled', initialAmount: '1000.00', spentTotal: '0.00' }),
    ).toBe('disabled');
  });

  it('🔴 expired НЕ оживает пополнением: срок продлевается отдельно (деньги ≠ время)', () => {
    expect(
      reviveStatusAfterTopUp({ status: 'expired', initialAmount: '1000.00', spentTotal: '0.00' }),
    ).toBe('expired');
  });

  it('active не трогается', () => {
    expect(
      reviveStatusAfterTopUp({ status: 'active', initialAmount: '1000.00', spentTotal: '0.00' }),
    ).toBe('active');
  });
});

describe('находка №10 — пополнение через updateGiftCertificate', () => {
  it('исчерпанный + пополнение → в репозиторий уходит reviveStatus=active', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () =>
        makeCert({ status: 'depleted', initialAmount: '500.00', spentTotal: '500.00' }),
      ),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '1500.00' });
    expect(r.ok).toBe(true);
    const upd = repo.updateGiftFields.mock.calls[0]![0];
    expect(upd.reviveStatus).toBe('active');
  });

  it('пополнение НЕ выше потраченного (равно) → статус не оживляем', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () =>
        makeCert({ status: 'depleted', initialAmount: '500.00', spentTotal: '500.00' }),
      ),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '500.00' });
    expect(r.ok).toBe(true);
    expect(repo.updateGiftFields.mock.calls[0]![0].reviveStatus).toBeNull();
  });

  it('🔴 отключённый сертификат пополнением не оживает', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () =>
        makeCert({ status: 'disabled', initialAmount: '500.00', spentTotal: '500.00' }),
      ),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '1500.00' });
    expect(r.ok).toBe(true);
    expect(repo.updateGiftFields.mock.calls[0]![0].reviveStatus).toBeNull();
  });

  it('правка без номинала статус не трогает вовсе', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () => makeCert({ status: 'depleted' })),
    });
    await actions.updateGiftCertificate({ id: VALID_ID, name: 'x' });
    expect(repo.updateGiftFields.mock.calls[0]![0].reviveStatus).toBeNull();
  });

  it('audit пополнения фиксирует смену статуса (оператор должен видеть оживление)', async () => {
    const { actions, writeAudit } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () =>
        makeCert({ status: 'depleted', initialAmount: '500.00', spentTotal: '500.00' }),
      ),
      updateGiftFields: vi.fn(async (_i: UpdateFieldsInput) => makeCert({ status: 'active' })),
    });
    await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '1500.00' });
    const entry = writeAudit.mock.calls[0]![0] as unknown as {
      before: { status?: string };
      after: { status?: string };
    };
    expect(entry.before.status).toBe('depleted');
    expect(entry.after.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Минор №3 — статус 'expired' выставляется (крон-задача).
// ---------------------------------------------------------------------------

describe('минор №3 — expiredGiftStatus (чистое правило пометки истёкших)', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');

  it('active со сроком в прошлом → expired', () => {
    expect(
      expiredGiftStatus({ status: 'active', validUntil: new Date('2026-07-27T00:00:00Z') }, now),
    ).toBe('expired');
  });

  it('depleted со сроком в прошлом → expired (остаток мог вернуться рефандом)', () => {
    expect(
      expiredGiftStatus({ status: 'depleted', validUntil: new Date('2026-07-27T00:00:00Z') }, now),
    ).toBe('expired');
  });

  it('срок в будущем → null (нечего менять)', () => {
    expect(
      expiredGiftStatus({ status: 'active', validUntil: new Date('2026-07-29T00:00:00Z') }, now),
    ).toBeNull();
  });

  it('бессрочный (validUntil=null) → null', () => {
    expect(expiredGiftStatus({ status: 'active', validUntil: null }, now)).toBeNull();
  });

  it('🔴 disabled НЕ переводится в expired: иначе истечение срока «отменяло» бы блокировку', () => {
    expect(
      expiredGiftStatus({ status: 'disabled', validUntil: new Date('2020-01-01T00:00:00Z') }, now),
    ).toBeNull();
  });

  it('уже expired → null (идемпотентность крона)', () => {
    expect(
      expiredGiftStatus({ status: 'expired', validUntil: new Date('2020-01-01T00:00:00Z') }, now),
    ).toBeNull();
  });

  it('граница: срок ровно сейчас считается истёкшим (как в assertRedeemable)', () => {
    expect(expiredGiftStatus({ status: 'active', validUntil: new Date(now) }, now)).toBe('expired');
  });
});

describe('минор №3 — крон-задача истечения', () => {
  it('имя задачи объявлено доменом, а не строкой в роуте', () => {
    expect(GIFT_EXPIRE_TASK).toBe('expire-outdated');
  });

  it('роут крона знает обе задачи', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/api/cron/gift/[task]/route.ts', 'utf8');
    expect(src).toContain('issue-pending');
    expect(src).toContain('GIFT_EXPIRE_TASK');
  });
});

describe('минор №3 — воркер runExpireOutdated (без БД)', () => {
  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child() {
      return silentLogger;
    },
  };

  const grantingLock = async (_key: string, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    result: await fn(),
  });

  async function run(over: Record<string, unknown> = {}) {
    const { runExpireOutdated, GIFT_EXPIRE_LIMIT } = await import('@/lib/gift-certificates/cron');
    const markExpired = vi.fn(async (_limit?: number) => 3);
    const stats = await runExpireOutdated({
      markExpired,
      withLock: grantingLock as never,
      logger: silentLogger as never,
      ...over,
    } as never);
    return { stats, markExpired, GIFT_EXPIRE_LIMIT };
  }

  it('помечает истёкшие и отдаёт их число в статистике', async () => {
    const { stats, markExpired, GIFT_EXPIRE_LIMIT } = await run();
    expect(stats.ok).toBe(true);
    expect(stats.scanned).toBe(3);
    expect(stats.lockSkipped).toBe(false);
    expect(markExpired).toHaveBeenCalledWith(GIFT_EXPIRE_LIMIT);
  });

  it('лок занят параллельным прогоном → штатный no-op, БД не трогаем', async () => {
    const markExpired = vi.fn(async () => 0);
    const { runExpireOutdated } = await import('@/lib/gift-certificates/cron');
    const stats = await runExpireOutdated({
      markExpired,
      withLock: (async () => ({ acquired: false })) as never,
      logger: silentLogger as never,
    } as never);
    expect(stats.lockSkipped).toBe(true);
    expect(markExpired).not.toHaveBeenCalled();
  });

  it('🔴 сбой БД → ok=false (роут обязан отдать не-2xx, иначе провал = «успех»)', async () => {
    const { stats } = await run({
      markExpired: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    expect(stats.ok).toBe(false);
    expect(stats.failed).toBe(1);
  });

  it('🔴 ни кодов, ни id сертификатов в статистике (деньги на предъявителя)', async () => {
    const { stats } = await run();
    expect(JSON.stringify(stats)).not.toMatch(/code|certificateId/i);
  });
});
