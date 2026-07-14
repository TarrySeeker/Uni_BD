import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { DEFAULT_LOCALE_CONFIG } from '@/lib/i18n';
import {
  createGiftActions,
  type GiftActionDeps,
} from '@/lib/gift-certificates/actions';
import type { GiftCertificate } from '@/lib/gift-certificates/types';

/**
 * ЮНИТ — Server Actions выпуска/обновления/статуса без БД/Next: репозиторий,
 * config и пайплайн инъецированы (createGiftActions(deps)). Проверяем: guard
 * gift.write, модуль-гейт orders, audit, доменные правила (номинал только вверх).
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
    spentTotal: '100.00',
    remaining: '400.00',
    currency: 'RUB',
    status: 'active',
    validUntil: null,
    translations: {},
    comment: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function build(user: AuthUser | null, over: Partial<GiftActionDeps> = {}) {
  const a = makeActionDeps(user);
  const repo = {
    insertGiftCertificate: vi.fn(async (row) => makeCert({ id: 'new-id', code: row.code })),
    getGiftCertificateById: vi.fn(async () => makeCert()),
    updateGiftStatus: vi.fn(async () => true),
    updateGiftFields: vi.fn(async () => makeCert()),
  };
  const deps: GiftActionDeps = {
    actionDeps: a.actionDeps,
    isOrdersEnabled: vi.fn(async () => true),
    getLocaleConfig: vi.fn(async () => DEFAULT_LOCALE_CONFIG),
    ...repo,
    ...over,
  };
  return { actions: createGiftActions(deps), repo, deps, ...a };
}

const VALID_ID = '11111111-1111-4111-8111-111111111111';

describe('gift actions — guard', () => {
  it('без gift.write → forbidden', async () => {
    const { actions } = build(makeUser(['gift.read']));
    const r = await actions.issueGiftCertificate({ code: 'G', initialAmount: '100.00' });
    expect(r).toEqual({ ok: false, error: 'forbidden' });
  });

  it('без пользователя → unauthorized', async () => {
    const { actions } = build(null);
    const r = await actions.issueGiftCertificate({ code: 'G', initialAmount: '100.00' });
    expect(r).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('модуль orders выключен → validation-ошибка', async () => {
    const { actions } = build(makeUser(['gift.write']), { isOrdersEnabled: vi.fn(async () => false) });
    const r = await actions.issueGiftCertificate({ code: 'G', initialAmount: '100.00' });
    expect(r.ok).toBe(false);
  });
});

describe('gift actions — issue', () => {
  it('выпускает сертификат и пишет audit gift.issue', async () => {
    const { actions, repo, writeAudit } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftCertificate({ code: 'GIFT500', initialAmount: '500.00' });
    expect(r.ok).toBe(true);
    expect(repo.insertGiftCertificate).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledOnce();
    const entry = writeAudit.mock.calls[0]![0];
    expect(entry.action).toBe('gift.issue');
  });

  it('дубликат кода (23505) → доменная ошибка', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    const { actions } = build(makeUser(['gift.write']), {
      insertGiftCertificate: vi.fn(async () => {
        throw dup;
      }),
    });
    const r = await actions.issueGiftCertificate({ code: 'GIFT500', initialAmount: '500.00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/уже существует/i);
  });
});

describe('gift actions — update (номинал только вверх)', () => {
  it('снижение номинала ниже текущего → face_below_spent', async () => {
    const { actions } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () => makeCert({ initialAmount: '500.00', spentTotal: '100.00' })),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '400.00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/увеличивать|потраченной/i);
  });

  it('пополнение (номинал вверх) → успех + audit gift.update', async () => {
    const { actions, repo, writeAudit } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () => makeCert({ initialAmount: '500.00', spentTotal: '100.00' })),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, initialAmount: '1000.00' });
    expect(r.ok).toBe(true);
    expect(repo.updateGiftFields).toHaveBeenCalledOnce();
    expect((writeAudit.mock.calls[0]![0]).action).toBe('gift.update');
  });

  it('несуществующий id → not_found', async () => {
    const { actions } = build(makeUser(['gift.write']), {
      getGiftCertificateById: vi.fn(async () => null),
    });
    const r = await actions.updateGiftCertificate({ id: VALID_ID, name: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('gift actions — setGiftStatus (деактивация)', () => {
  it('active→disabled пишет audit gift.status.change', async () => {
    const { actions, repo, writeAudit } = build(makeUser(['gift.write']));
    const r = await actions.setGiftStatus({ id: VALID_ID, status: 'disabled' });
    expect(r.ok).toBe(true);
    expect(repo.updateGiftStatus).toHaveBeenCalledWith(VALID_ID, 'disabled');
    expect((writeAudit.mock.calls[0]![0]).action).toBe('gift.status.change');
  });
});
