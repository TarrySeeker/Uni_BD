import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { DEFAULT_LOCALE_CONFIG } from '@/lib/i18n';
import {
  createGiftActions,
  type GiftActionDeps,
  type UpdateFieldsInput,
} from '@/lib/gift-certificates/actions';
import type { GiftCertificate } from '@/lib/gift-certificates/types';
import type { GiftIssueSourceRow } from '@/lib/gift-certificates/repository';

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

/** Источник выпуска «по заказу»: заголовок заказа + ценовой снимок позиции. */
function makeSource(over: Partial<GiftIssueSourceRow> = {}): GiftIssueSourceRow {
  return {
    orderId: ORDER_ID,
    orderNumber: 'CR-2026-000042',
    currency: 'RUB',
    customerId: null,
    customerName: 'Пётр Гость',
    customerEmail: 'guest@shop.io',
    customerPhone: '+79990000000',
    // Калитка ручного выпуска (находка аудита №27): по умолчанию заказ оплачен
    // и жив, иначе выпуск теперь отбивается — см. manual-issue-gate.test.ts.
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
    // Политика магазина и генератор кода — новые зависимости ручного выпуска
    // (находки №27 и №13); в юнитах инъецируются детерминированно.
    getGiftSettings: vi.fn(async () => ({
      autoIssue: true,
      validDays: 0,
      categorySlugs: [] as string[],
      allowIssueOnGiftPaidOrder: true,
    })),
    randomCode: vi.fn(() => 'TEST-RAND-CODE-0001'),
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

describe('gift actions — стороны сделки (ТЗ п.7)', () => {
  it('issue сохраняет снимки «кто купил» и «на чьё имя», источник manual', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftCertificate({
      code: 'GIFT500',
      initialAmount: '500.00',
      purchaser: { name: '  Иван  ', email: 'ivan@shop.io', phone: '' },
      recipient: { name: 'Мария' },
    });
    expect(r.ok).toBe(true);
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    expect(row.purchaser).toEqual({ name: 'Иван', email: 'ivan@shop.io', phone: null });
    expect(row.recipient).toEqual({ name: 'Мария', email: null, phone: null });
    expect(row.issueSource).toBe('manual');
  });

  it('update без блока сторон НЕ затирает снимки (provided-флаги false)', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.updateGiftCertificate({ id: VALID_ID, name: 'x' });
    expect(r.ok).toBe(true);
    const upd = repo.updateGiftFields.mock.calls[0]![0];
    expect(upd.purchaserProvided).toBe(false);
    expect(upd.recipientProvided).toBe(false);
  });

  it('update с блоком получателя пишет снимок', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.updateGiftCertificate({
      id: VALID_ID,
      recipient: { name: 'Ольга', email: 'olga@shop.io' },
    });
    expect(r.ok).toBe(true);
    const upd = repo.updateGiftFields.mock.calls[0]![0];
    expect(upd.recipientProvided).toBe(true);
    expect(upd.recipient).toEqual({ name: 'Ольга', email: 'olga@shop.io', phone: null });
  });

  it('некорректный email стороны → validation', async () => {
    const { actions } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftCertificate({
      code: 'G1',
      initialAmount: '100.00',
      purchaser: { email: 'не-email' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('validation');
  });
});

describe('gift actions — issueGiftFromOrder (ТЗ п.7)', () => {
  it('номинал берётся из СНИМКА позиции, а не из ввода', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({
          item: {
            id: ITEM_ID,
            nameSnapshot: 'Сертификат',
            skuSnapshot: 'C',
            attributesSnapshot: {},
            unitPrice: '2000.00',
            quantity: 2,
            lineTotal: '4000.00',
          },
        }),
      ),
    });
    const r = await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      initialAmount: '999999.00',
    });
    expect(r.ok).toBe(true);
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    expect(row.initialAmount).toBe('4000.00');
  });

  it('покупатель — из денормализованных полей заказа, получатель — из формы', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      recipient: { name: 'Анна', email: 'anna@shop.io' },
    });
    expect(r.ok).toBe(true);
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    expect(row.purchaser).toEqual({
      name: 'Пётр Гость',
      email: 'guest@shop.io',
      phone: '+79990000000',
    });
    expect(row.recipient).toEqual({ name: 'Анна', email: 'anna@shop.io', phone: null });
    expect(row.issueSource).toBe('order');
    expect(row.issuedOrderId).toBe(ORDER_ID);
    expect(row.issuedOrderItemId).toBe(ITEM_ID);
  });

  /**
   * Находка аудита №13: раньше код без ввода строился ДЕТЕРМИНИРОВАННО из номера
   * заказа (~24 бита) и перебирался через публичный /cart/quote. Теперь ручной
   * путь, как и автовыпуск, берёт криптослучайный код. Подробности — в
   * tests/gift-certificates/manual-issue-gate.test.ts.
   */
  it('без кода берёт КРИПТОСЛУЧАЙНЫЙ код, а не выводит его из номера заказа', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    expect(row.code).toBe('TEST-RAND-CODE-0001');
    expect(row.code).not.toContain('CR-2026-000042');
  });

  it('позиция другого заказа/не найдена → not_found', async () => {
    const { actions } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () => null),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/не найдена/i);
  });

  it('бесплатная позиция (номинал 0) → отказ', async () => {
    const { actions } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({
          item: {
            id: ITEM_ID,
            nameSnapshot: 'Подарок',
            skuSnapshot: 'G',
            attributesSnapshot: {},
            unitPrice: '0.00',
            quantity: 1,
            lineTotal: '0.00',
          },
        }),
      ),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/больше нуля/i);
  });

  it('повторный выпуск по той же позиции (23505 частичного UNIQUE) → duplicate_issue', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    const { actions } = build(makeUser(['gift.write']), {
      insertGiftCertificate: vi.fn(async () => {
        throw dup;
      }),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/уже выпущен/i);
  });

  it('без права gift.write → forbidden; audit пишется как gift.issue при успехе', async () => {
    const denied = build(makeUser(['gift.read']));
    const r1 = await denied.actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r1).toEqual({ ok: false, error: 'forbidden' });

    const allowed = build(makeUser(['gift.write']));
    const r2 = await allowed.actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r2.ok).toBe(true);
    const entry = allowed.writeAudit.mock.calls[0]![0];
    expect(entry.action).toBe('gift.issue');
  });
});
