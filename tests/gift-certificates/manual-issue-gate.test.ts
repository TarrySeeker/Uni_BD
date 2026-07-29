import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import { DEFAULT_LOCALE_CONFIG } from '@/lib/i18n';
import {
  createGiftActions,
  manualIssueGateReason,
  type GiftActionDeps,
  type UpdateFieldsInput,
} from '@/lib/gift-certificates/actions';
import { GIFT_CODE_ALPHABET } from '@/lib/gift-certificates/origin';
import type { GiftCertificate } from '@/lib/gift-certificates/types';
import type { GiftIssueSourceRow } from '@/lib/gift-certificates/repository';

/**
 * РУЧНОЙ ВЫПУСК по позиции заказа — аудит-находки №13 (предсказуемый код) и
 * №27 (выпуск без единого гейта).
 *
 * №13: код на предъявителя обязан быть криптослучайным (как в автопути), а не
 * выводиться из последовательного номера заказа: публичный /cart/quote отвечает
 * applied/not_found и работает оракулом перебора.
 *
 * №27: ручной путь получает ТЕ ЖЕ калитки, что автопуть (order_not_paid /
 * order_not_eligible), но с ЯВНЫМ осознанным исключением: оператор с правом
 * gift.write может выпустить принудительно, передав override — тогда причина
 * попадает в аудит. Отсутствие флага = отказ (безопасно по умолчанию).
 */

function makeUser(perms: PermissionCode[]): AuthUser {
  return { id: 'u-1', email: 'op@shop.io', isOwner: false, permissions: new Set(perms) };
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
    spentTotal: '0.00',
    remaining: '500.00',
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
const PAID_AT = new Date('2026-01-01T00:00:00.000Z');

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
    paidAt: PAID_AT,
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

const SETTINGS = {
  autoIssue: true,
  validDays: 0,
  categorySlugs: [] as string[],
  allowIssueOnGiftPaidOrder: true,
};

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
    getGiftSettings: vi.fn(async () => ({ ...SETTINGS })),
    randomCode: vi.fn(() => 'RAND-OMCO-DE00-0000'),
    ...repo,
    ...over,
  };
  return { actions: createGiftActions(deps), repo, deps, ...a };
}

// ---------------------------------------------------------------------------
// №13 — код ручного выпуска криптослучаен.
// ---------------------------------------------------------------------------

describe('находка №13 — код ручного выпуска не выводится из номера заказа', () => {
  it('🔴 без явного кода берётся randomCode, а НЕ детерминированный по заказу', async () => {
    const { actions, repo, deps } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(true);
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    expect(deps.randomCode).toHaveBeenCalled();
    expect(row.code).toBe('RAND-OMCO-DE00-0000');
    // Номер заказа в коде НЕ фигурирует — иначе код перебирается по ~24 битам.
    expect(row.code).not.toContain('CR-2026-000042');
    expect(row.code).not.toContain('000042');
  });

  it('🔴 прод-код исходника: buildGiftCodeForOrderItem больше не вызывается в actions', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/gift-certificates/actions.ts', 'utf8');
    expect(src).not.toMatch(/buildGiftCodeForOrderItem\s*\(/);
    expect(src).toContain('randomCode');
  });

  it('прод-зависимости подставляют криптостойкий генератор', async () => {
    const { productionGiftDeps } = await import('@/lib/gift-certificates/actions');
    const code = productionGiftDeps().randomCode();
    // 16 символов Crockford base32, сгруппированы по 4 → 19 символов с дефисами.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    for (const ch of code.replace(/-/g, '')) {
      expect(GIFT_CODE_ALPHABET).toContain(ch);
    }
    // Два вызова подряд не совпадают (CSPRNG, а не счётчик).
    expect(productionGiftDeps().randomCode()).not.toBe(code);
  });

  it('явно переданный оператором код по-прежнему уважается (перенос бумажного бланка)', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      code: 'PAPER-0001',
    });
    expect(r.ok).toBe(true);
    expect(repo.insertGiftCertificate.mock.calls[0]![0].code).toBe('PAPER-0001');
  });
});

// ---------------------------------------------------------------------------
// №27 — гейты ручного выпуска.
// ---------------------------------------------------------------------------

describe('находка №27 — manualIssueGateReason (чистое правило)', () => {
  it('оплаченный живой заказ → null (выпуск разрешён)', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'paid', status: 'paid', giftCertificateId: null },
        SETTINGS,
      ),
    ).toBeNull();
  });

  it('неоплаченный заказ → order_not_paid', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'pending', status: 'new', giftCertificateId: null },
        SETTINGS,
      ),
    ).toBe('order_not_paid');
  });

  it('отменённый заказ → order_not_eligible', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'paid', status: 'cancelled', giftCertificateId: null },
        SETTINGS,
      ),
    ).toBe('order_not_eligible');
  });

  it('возвращённый заказ → order_not_eligible', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'paid', status: 'refunded', giftCertificateId: null },
        SETTINGS,
      ),
    ).toBe('order_not_eligible');
  });

  it('оплачен сертификатом при выключенной настройке → paid_with_gift', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'paid', status: 'paid', giftCertificateId: 'g-1' },
        { ...SETTINGS, allowIssueOnGiftPaidOrder: false },
      ),
    ).toBe('paid_with_gift');
  });

  it('оплачен сертификатом при включённой настройке → null', () => {
    expect(
      manualIssueGateReason(
        { paymentStatus: 'paid', status: 'paid', giftCertificateId: 'g-1' },
        { ...SETTINGS, allowIssueOnGiftPaidOrder: true },
      ),
    ).toBeNull();
  });

  it('🔴 гейт ТОТ ЖЕ, что у автопути: набор причин совпадает', async () => {
    const auto = await import('@/lib/gift-certificates/auto-issue');
    // Автопуть считает те же причины по тем же полям — сравниваем поведение.
    for (const snap of [
      { paymentStatus: 'pending' as const, status: 'new' as const },
      { paymentStatus: 'paid' as const, status: 'cancelled' as const },
      { paymentStatus: 'paid' as const, status: 'refunded' as const },
      { paymentStatus: 'paid' as const, status: 'paid' as const },
    ]) {
      expect(manualIssueGateReason({ ...snap, giftCertificateId: null }, SETTINGS)).toBe(
        auto.orderGateReason(snap as never),
      );
    }
  });
});

describe('находка №27 — issueGiftFromOrder применяет гейты', () => {
  it('🔴 НЕОПЛАЧЕННЫЙ заказ → отказ, сертификат не создаётся', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({ paymentStatus: 'pending', status: 'new', paidAt: null }),
      ),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/не оплачен/i);
    expect(repo.insertGiftCertificate).not.toHaveBeenCalled();
  });

  it('🔴 ОТМЕНЁННЫЙ заказ → отказ', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () => makeSource({ status: 'cancelled' })),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    expect(repo.insertGiftCertificate).not.toHaveBeenCalled();
  });

  it('🔴 ВОЗВРАЩЁННЫЙ заказ → отказ', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () => makeSource({ status: 'refunded' })),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    expect(repo.insertGiftCertificate).not.toHaveBeenCalled();
  });

  it('заказ, оплаченный сертификатом, при выключенной настройке → отказ', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () => makeSource({ giftCertificateId: 'g-9' })),
      getGiftSettings: vi.fn(async () => ({ ...SETTINGS, allowIssueOnGiftPaidOrder: false })),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(false);
    expect(repo.insertGiftCertificate).not.toHaveBeenCalled();
  });

  it('оплаченный живой заказ выпускается как раньше', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(true);
    expect(repo.insertGiftCertificate).toHaveBeenCalledOnce();
  });
});

describe('находка №27 — осознанное ручное исключение (override)', () => {
  it('override + причина → выпуск разрешён по неоплаченному заказу', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({ paymentStatus: 'pending', status: 'new', paidAt: null }),
      ),
    });
    const r = await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      overrideGate: true,
      comment: 'оплата наличными в салоне, чек №12',
    });
    expect(r.ok).toBe(true);
    expect(repo.insertGiftCertificate).toHaveBeenCalledOnce();
  });

  it('🔴 override БЕЗ письменного обоснования (comment) → отказ', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({ paymentStatus: 'pending', status: 'new', paidAt: null }),
      ),
    });
    const r = await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      overrideGate: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/причин|обоснован|комментар/i);
    expect(repo.insertGiftCertificate).not.toHaveBeenCalled();
  });

  it('🔴 обход калитки попадает в АУДИТ с причиной (иначе он невидим владельцу)', async () => {
    const { actions, writeAudit } = build(makeUser(['gift.write']), {
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({ paymentStatus: 'pending', status: 'new', paidAt: null }),
      ),
    });
    await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      overrideGate: true,
      comment: 'оплата наличными в салоне',
    });
    const entry = writeAudit.mock.calls[0]![0] as unknown as {
      after: { gateOverridden?: boolean; gateReason?: string };
    };
    expect(entry.after.gateOverridden).toBe(true);
    expect(entry.after.gateReason).toBe('order_not_paid');
  });

  it('🔴 обход НЕ логируется в поток приложения (код рядом — деньги на предъявителя)', async () => {
    // Аудит — таблица под правом audit.read, туда код писать штатно (так же
    // делает ручной issueGiftCertificate). А вот console/logger обходом не
    // шумим: логи уезжают в docker json-file рядом с кодом сертификата.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/gift-certificates/actions.ts', 'utf8');
    expect(src).not.toMatch(/console\.(log|warn|error|info)/);
    expect(src).not.toMatch(/logger\./);
  });

  it('override не нужен и не помечается, когда калитка и так открыта', async () => {
    const { actions, writeAudit } = build(makeUser(['gift.write']));
    await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      overrideGate: true,
      comment: 'на всякий случай',
    });
    const entry = writeAudit.mock.calls[0]![0] as unknown as {
      after: { gateOverridden?: boolean };
    };
    expect(entry.after.gateOverridden).toBeUndefined();
  });
});

describe('находка №27 — форма админки отражает калитку (GUARD по исходнику)', () => {
  const read = async (rel: string): Promise<string> =>
    (await import('node:fs')).readFileSync(rel, 'utf8');

  it('карточка заказа считает калитку ТЕМ ЖЕ правилом, что и действие', async () => {
    const page = await read('app/admin/(panel)/orders/[id]/page.tsx');
    expect(page).toContain('manualIssueGateReason');
    expect(page).toContain('orderEligible={giftGate === null}');
  });

  it('блок выпуска требует галку обхода И основание, иначе кнопка заблокирована', async () => {
    const block = await read('app/admin/(panel)/orders/[id]/_components/GiftIssueBlock.tsx');
    expect(block).toContain('overrideGate');
    expect(block).toContain('orders.detailGiftIssueBlock.gateBlocked');
    expect(block).toContain('orders.detailGiftIssueBlock.gateReasonLabel');
    // Кнопка «Выпустить» недоступна при незаполненном основании.
    expect(block).toMatch(/!orderEligible && \(!overrideGate \|\| justification\.trim\(\) === ''\)/);
  });

  it('🔴 обход НЕ включён по умолчанию (безопасное умолчание)', async () => {
    const block = await read('app/admin/(panel)/orders/[id]/_components/GiftIssueBlock.tsx');
    expect(block).toMatch(/useState\(false\)[^\n]*\n?/);
    expect(block).toMatch(/overrideGate,\s*setOverrideGate\]\s*=\s*useState\(false\)/);
    // Флаг уходит на сервер только когда калитка закрыта И оператор подтвердил.
    expect(block).toMatch(/overrideGate:\s*!orderEligible && overrideGate/);
  });

  it('подписи обхода есть во всех трёх каталогах и en/fr не копия русского', async () => {
    const cats = {
      ru: JSON.parse(await read('messages/ru.json')) as Record<string, never>,
      en: JSON.parse(await read('messages/en.json')) as Record<string, never>,
      fr: JSON.parse(await read('messages/fr.json')) as Record<string, never>,
    };
    const pick = (c: Record<string, never>, k: string): string =>
      ((c as Record<string, Record<string, Record<string, Record<string, string>>>>).orders
        ?.detailGiftIssueBlock?.[k] as unknown as string) ?? '';
    for (const key of [
      'gateBlocked',
      'gateOverrideLabel',
      'gateReasonLabel',
      'gateReasonPlaceholder',
    ]) {
      expect(pick(cats.ru, key), `ru:${key}`).not.toBe('');
      expect(pick(cats.en, key), `en:${key}`).not.toBe('');
      expect(pick(cats.fr, key), `fr:${key}`).not.toBe('');
      expect(pick(cats.en, key), `en:${key} — копия ru`).not.toBe(pick(cats.ru, key));
      expect(pick(cats.fr, key), `fr:${key} — копия ru`).not.toBe(pick(cats.ru, key));
      // Русского текста в en/fr быть не должно.
      expect(pick(cats.en, key), `en:${key} — кириллица`).not.toMatch(/[а-яА-ЯёЁ]/);
      expect(pick(cats.fr, key), `fr:${key} — кириллица`).not.toMatch(/[а-яА-ЯёЁ]/);
    }
  });
});

describe('находка №27 — срок действия ручного кода не «навсегда по умолчанию»', () => {
  it('настройка validDays применяется, если оператор срок не задал', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftSettings: vi.fn(async () => ({ ...SETTINGS, validDays: 30 })),
    });
    const r = await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(r.ok).toBe(true);
    const row = repo.insertGiftCertificate.mock.calls[0]![0];
    // 30 дней от ОПЛАТЫ (как в автопути), а не от now().
    expect(row.validUntil?.toISOString()).toBe(
      new Date(PAID_AT.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
    );
  });

  it('явный срок оператора перебивает настройку', async () => {
    const explicit = new Date('2027-03-01T00:00:00.000Z');
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftSettings: vi.fn(async () => ({ ...SETTINGS, validDays: 30 })),
    });
    await actions.issueGiftFromOrder({
      orderId: ORDER_ID,
      orderItemId: ITEM_ID,
      validUntil: explicit,
    });
    expect(repo.insertGiftCertificate.mock.calls[0]![0].validUntil?.toISOString()).toBe(
      explicit.toISOString(),
    );
  });

  it('validDays=0 (бессрочно по политике магазина) → срок null', async () => {
    const { actions, repo } = build(makeUser(['gift.write']));
    await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(repo.insertGiftCertificate.mock.calls[0]![0].validUntil).toBeNull();
  });

  it('срок из СНИМКА позиции (товар «бессрочный сертификат») сильнее настройки', async () => {
    const { actions, repo } = build(makeUser(['gift.write']), {
      getGiftSettings: vi.fn(async () => ({ ...SETTINGS, validDays: 30 })),
      getOrderItemForGiftIssue: vi.fn(async () =>
        makeSource({
          item: {
            id: ITEM_ID,
            nameSnapshot: 'Бессрочный сертификат',
            skuSnapshot: 'C',
            attributesSnapshot: { gift_certificate: true, gift_valid_days: 0 },
            unitPrice: '1000.00',
            quantity: 1,
            lineTotal: '1000.00',
          },
        }),
      ),
    });
    await actions.issueGiftFromOrder({ orderId: ORDER_ID, orderItemId: ITEM_ID });
    expect(repo.insertGiftCertificate.mock.calls[0]![0].validUntil).toBeNull();
  });
});
