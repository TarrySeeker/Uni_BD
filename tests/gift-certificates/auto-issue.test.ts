import { describe, it, expect, vi } from 'vitest';
import type { TransactionSql } from 'postgres';

import {
  GIFT_CODE_ALPHABET,
  GIFT_VALID_DAYS_KEYS,
  giftValidDaysFor,
  giftValidUntil,
  isGiftItemForAutoIssue,
  randomGiftCode,
  type CertificateSourceItem,
} from '@/lib/gift-certificates/origin';
import {
  createGiftAutoIssuer,
  type AutoIssueDeps,
  type AutoIssueOrderSnapshot,
} from '@/lib/gift-certificates/auto-issue';
import type { IssueGiftCertificateRow, IssuedGiftRef } from '@/lib/gift-certificates/repository';
import type { LogContext, Logger } from '@/lib/logger';
import type { ResolvedGiftSettings } from '@/lib/gift-certificates/types';

/**
 * ЮНИТ — ядро автовыпуска подарочных сертификатов (ТЗ владельца п.11).
 *
 * Проверяется СУТЬ, а не реализация: криптостойкость кода (детерминированный код
 * перебираем через публичный оракул quote), «только маркер решает» (ложное
 * срабатывание по имени = бесплатные деньги), срок от paid_at (а не от now()),
 * идемпотентность на частичном UNIQUE и — главное — что падение выпуска НИКОГДА
 * не выходит наружу (вызывающий = транзакция вебхука, где throw откатит факт оплаты).
 */

const ITEM_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ORDER_ID = 'oooooooo-1111-4111-8111-111111111111';

function item(over: Partial<CertificateSourceItem> = {}): CertificateSourceItem {
  return {
    id: ITEM_ID,
    nameSnapshot: 'Подарочный сертификат 5000 ₽',
    skuSnapshot: 'GC-5000',
    attributesSnapshot: { gift_certificate: true },
    unitPrice: '5000.00',
    quantity: 1,
    lineTotal: '5000.00',
    ...over,
  };
}

function order(over: Partial<AutoIssueOrderSnapshot> = {}): AutoIssueOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderNumber: 'CR-2026-000123',
    currency: 'RUB',
    status: 'paid',
    paymentStatus: 'paid',
    paidAt: new Date('2026-03-01T10:00:00Z'),
    giftCertificateId: null,
    customerId: null,
    customerName: 'Аня',
    customerEmail: 'anya@example.com',
    customerPhone: '+70000000000',
    items: [item()],
    ...over,
  };
}

/** Разрешённая политика (дефолты ⊕ оверрайд) — ровно то, что даёт реестр настроек. */
const SETTINGS_ON: ResolvedGiftSettings = {
  autoIssue: true,
  validDays: 0,
  categorySlugs: [],
  allowIssueOnGiftPaidOrder: false,
};

/** Уникальное нарушение с именем индекса (как отдаёт postgres.js). */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: constraint });
}

/** Тестовый набор зависимостей: «БД» — Set-ы, имитирующие два UNIQUE-индекса. */
function makeDeps(over: Partial<AutoIssueDeps> = {}) {
  const issuedItems = new Set<string>();
  const codes = new Set<string>();
  const inserted: IssueGiftCertificateRow[] = [];
  const txCalls: unknown[] = [];
  const locked: string[] = [];
  const logged: { msg: string; ctx?: Record<string, unknown> }[] = [];

  const deps: AutoIssueDeps = {
    getGiftSettings: async () => SETTINGS_ON,
    getOrderForAutoIssue: async () => order(),
    withTransaction: async <T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> => {
      const tx = {} as TransactionSql;
      txCalls.push(tx);
      return fn(tx);
    },
    lockOrderTx: async (_tx: TransactionSql, orderId: string) => {
      locked.push(orderId);
    },
    insertGiftTx: async (_tx: TransactionSql, row: IssueGiftCertificateRow): Promise<IssuedGiftRef> => {
      if (row.issuedOrderItemId && issuedItems.has(row.issuedOrderItemId)) {
        throw uniqueViolation('gift_certificates_issued_item_uniq');
      }
      if (codes.has(row.code.toUpperCase())) {
        throw uniqueViolation('gift_certificates_code_uniq');
      }
      if (row.issuedOrderItemId) issuedItems.add(row.issuedOrderItemId);
      codes.add(row.code.toUpperCase());
      inserted.push(row);
      return { id: `cert-${inserted.length}`, code: row.code, initialAmount: row.initialAmount };
    },
    logger: {
      debug: (msg: string, ctx?: LogContext) => logged.push({ msg, ctx }),
      info: (msg: string, ctx?: LogContext) => logged.push({ msg, ctx }),
      warn: (msg: string, ctx?: LogContext) => logged.push({ msg, ctx }),
      error: (msg: string, ctx?: LogContext) => logged.push({ msg, ctx }),
      child: (): Logger => deps.logger,
    },
    randomCode: randomGiftCode,
    ...over,
  };

  return { deps, inserted, txCalls, locked, logged, issuedItems, codes };
}

// =============================================================================
// Код сертификата: криптослучайность и алфавит.
// =============================================================================
describe('randomGiftCode — криптослучайный код на предъявителя', () => {
  it('формат XXXX-XXXX-XXXX-XXXX из алфавита Crockford без похожих символов', () => {
    const code = randomGiftCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    for (const ch of code.replace(/-/g, '')) {
      expect(GIFT_CODE_ALPHABET).toContain(ch);
    }
    // Похожие символы исключены (I/L/O/U) — код диктуют по телефону.
    expect(GIFT_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(GIFT_CODE_ALPHABET).toHaveLength(32);
  });

  it('100k генераций — ни одной коллизии (энтропия ~80 бит, не перебирается оракулом quote)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) seen.add(randomGiftCode());
    expect(seen.size).toBe(100_000);
  });

  it('код НЕ детерминирован по заказу: два вызова подряд различаются', () => {
    expect(randomGiftCode()).not.toBe(randomGiftCode());
  });
});

// =============================================================================
// Резолвер «позиция — сертификат для АВТОвыпуска».
// =============================================================================
describe('isGiftItemForAutoIssue — только маркер решает', () => {
  it('маркер в снимке → выпускаем', () => {
    expect(isGiftItemForAutoIssue(item({ attributesSnapshot: { gift_certificate: 'да' } }), SETTINGS_ON)).toBe(
      true,
    );
    expect(isGiftItemForAutoIssue(item({ attributesSnapshot: { is_gift_certificate: 1 } }), SETTINGS_ON)).toBe(
      true,
    );
  });

  it('совпадение ТОЛЬКО по имени → НИКОГДА не выпускаем (сертификат подлинности ≠ деньги)', () => {
    const cert = item({ nameSnapshot: 'Сертификат подлинности шёлка', attributesSnapshot: {} });
    expect(isGiftItemForAutoIssue(cert, SETTINGS_ON)).toBe(false);
    expect(isGiftItemForAutoIssue(item({ nameSnapshot: 'Gift certificate', attributesSnapshot: {} }), SETTINGS_ON)).toBe(
      false,
    );
  });

  it('пустой снимок атрибутов → false', () => {
    expect(isGiftItemForAutoIssue(item({ attributesSnapshot: {} }), SETTINGS_ON)).toBe(false);
  });

  it('маркер со значением false → false', () => {
    expect(isGiftItemForAutoIssue(item({ attributesSnapshot: { gift_certificate: false } }), SETTINGS_ON)).toBe(
      false,
    );
  });

  it('автовыпуск выключен настройкой → false даже с маркером', () => {
    expect(isGiftItemForAutoIssue(item(), { ...SETTINGS_ON, autoIssue: false })).toBe(false);
  });

  /**
   * КОНТРАКТ, который легко прочитать неверно: «пустой categorySlugs → автовыпуск
   * не применяется ни к чему» — НЕПРАВДА. Разделы работают на шаге оформления
   * (applyGiftCategoryMarker ставит маркер в снимок позиции); товар, у которого
   * признак сертификата задан своими атрибутами, помечен и без разделов.
   * Единственный рубильник — autoIssue.
   */
  it('пустой список разделов НЕ отключает выпуск: решает маркер в снимке позиции', () => {
    const noCategories = { ...SETTINGS_ON, categorySlugs: [] };
    expect(isGiftItemForAutoIssue(item(), noCategories)).toBe(true);
    expect(isGiftItemForAutoIssue(item({ attributesSnapshot: {} }), noCategories)).toBe(false);
    // А вот рубильник действительно выключает — при любом списке разделов.
    expect(
      isGiftItemForAutoIssue(item(), { ...noCategories, categorySlugs: ['gc'], autoIssue: false }),
    ).toBe(false);
  });
});

// =============================================================================
// Срок действия.
// =============================================================================
describe('giftValidDaysFor / giftValidUntil — срок от paid_at', () => {
  it('приоритет: снимок позиции > настройка магазина > null', () => {
    for (const key of GIFT_VALID_DAYS_KEYS) {
      expect(giftValidDaysFor(item({ attributesSnapshot: { [key]: 30 } }), { validDays: 365 })).toBe(30);
    }
    expect(giftValidDaysFor(item(), { validDays: 365 })).toBe(365);
    expect(giftValidDaysFor(item(), {})).toBeNull();
  });

  it('N пусто/0/отрицательное → null (бессрочно), снимок с 0 перебивает настройку', () => {
    expect(giftValidDaysFor(item({ attributesSnapshot: { gift_valid_days: 0 } }), { validDays: 365 })).toBeNull();
    expect(giftValidDaysFor(item({ attributesSnapshot: { gift_valid_days: '' } }), { validDays: 365 })).toBe(365);
    expect(giftValidDaysFor(item(), { validDays: 0 })).toBeNull();
    expect(giftValidDaysFor(item(), { validDays: -5 })).toBeNull();
  });

  it('строковое значение из ETL парсится', () => {
    expect(giftValidDaysFor(item({ attributesSnapshot: { gift_valid_days: '90' } }), {})).toBe(90);
  });

  it('отсчёт СТРОГО от paid_at, а не от now()', () => {
    const paidAt = new Date('2026-01-01T00:00:00Z');
    const until = giftValidUntil(paidAt, 30);
    expect(until?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    // Через месяц крон-догоняльщик обязан дать ТУ ЖЕ дату.
    expect(giftValidUntil(paidAt, 30)?.getTime()).toBe(until?.getTime());
  });

  it('days null → бессрочно; paidAt null → бессрочно (лучше, чем неверная дата)', () => {
    expect(giftValidUntil(new Date(), null)).toBeNull();
    expect(giftValidUntil(null, 30)).toBeNull();
  });
});

// Разбор самих настроек здесь НЕ дублируется: он живёт в реестре
// (lib/settings/schemas → resolveGiftSettings) и покрыт двумя файлами —
// tests/settings/gift-schema.test.ts и tests/settings/gift-defaults-single-source.test.ts
// (последний сторожит, что форма админки и этот конвейер видят ОДНИ дефолты).

// =============================================================================
// Конвейер автовыпуска.
// =============================================================================
describe('autoIssueGiftsForPaidOrder — конвейер', () => {
  it('оплаченный заказ с позицией-сертификатом → выпускает один код, issue_source=auto', async () => {
    const { deps, inserted } = makeDeps();
    const report = await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);

    expect(report.issued).toBe(1);
    expect(report.failed).toBe(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.issueSource).toBe('auto');
    expect(inserted[0]!.issuedOrderId).toBe(ORDER_ID);
    expect(inserted[0]!.issuedOrderItemId).toBe(ITEM_ID);
    expect(inserted[0]!.initialAmount).toBe('5000.00');
  });

  it('получатель = покупатель = снимок заказа', async () => {
    const { deps, inserted } = makeDeps({
      getOrderForAutoIssue: async () => order({ customerId: 'cust-1' }),
    });
    await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);

    expect(inserted[0]!.purchaser).toEqual({
      name: 'Аня',
      email: 'anya@example.com',
      phone: '+70000000000',
    });
    expect(inserted[0]!.recipient).toEqual(inserted[0]!.purchaser);
    expect(inserted[0]!.purchaserCustomerId).toBe('cust-1');
  });

  it('срок считается от paid_at заказа, а не от момента запуска', async () => {
    const { deps, inserted } = makeDeps({
      getGiftSettings: async () => ({ ...SETTINGS_ON, validDays: 30 }),
      getOrderForAutoIssue: async () => order({ paidAt: new Date('2026-01-01T00:00:00Z') }),
    });
    await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(inserted[0]!.validUntil?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('номинал: битый lineTotal → unitPrice × quantity; qty>1 → ОДИН код на всю сумму', async () => {
    const { deps, inserted } = makeDeps({
      getOrderForAutoIssue: async () =>
        order({ items: [item({ unitPrice: '2000.50', quantity: 2, lineTotal: '' })] }),
    });
    const report = await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.issued).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.initialAmount).toBe('4001.00');
  });

  it('позиция с нулевым номиналом → пропуск, а не сертификат на 0', async () => {
    const { deps, inserted } = makeDeps({
      getOrderForAutoIssue: async () =>
        order({ items: [item({ unitPrice: '0.00', quantity: 1, lineTotal: '0.00' })] }),
    });
    const report = await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.issued).toBe(0);
    expect(report.items[0]!.reason).toBe('zero_amount');
    expect(inserted).toHaveLength(0);
  });

  it('повторный вызов → already_issued без второго кода (идемпотентность на UNIQUE)', async () => {
    const ctx = makeDeps();
    const issuer = createGiftAutoIssuer(ctx.deps);
    const first = await issuer.autoIssueGiftsForPaidOrder(ORDER_ID);
    const second = await issuer.autoIssueGiftsForPaidOrder(ORDER_ID);

    expect(first.issued).toBe(1);
    expect(second.issued).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.items[0]!.reason).toBe('already_issued');
    expect(ctx.inserted).toHaveLength(1);
  });

  it('гонка «ручной выпуск ↔ автовыпуск» → ровно один код, автопуть не падает', async () => {
    const ctx = makeDeps();
    const issuer = createGiftAutoIssuer(ctx.deps);
    // Ручной выпуск успел первым (занял issued_order_item_id).
    await ctx.deps.insertGiftTx({} as TransactionSql, {
      code: 'MANUAL-1',
      name: 'Ручной',
      initialAmount: '5000.00',
      validUntil: null,
      description: null,
      terms: null,
      comment: '',
      translations: {},
      issuedOrderId: ORDER_ID,
      issuedOrderItemId: ITEM_ID,
      issueSource: 'order',
    });

    const report = await issuer.autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.issued).toBe(0);
    expect(report.items[0]!.reason).toBe('already_issued');
    expect(ctx.inserted).toHaveLength(1);
  });

  it('коллизия по коду → ретрай новым кодом (не считается дублем позиции)', async () => {
    const ctx = makeDeps();
    let calls = 0;
    const inner = ctx.deps.insertGiftTx;
    ctx.deps.insertGiftTx = async (tx: TransactionSql, row: IssueGiftCertificateRow) => {
      calls += 1;
      if (calls === 1) throw uniqueViolation('gift_certificates_code_uniq');
      return inner(tx, row);
    };
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.issued).toBe(1);
    expect(calls).toBe(2);
  });

  it('ОТДЕЛЬНАЯ транзакция на каждую позицию: падение по 2-й не откатывает 1-ю', async () => {
    const second = item({ id: 'bbbbbbbb-1111-4111-8111-111111111111' });
    const ctx = makeDeps({ getOrderForAutoIssue: async () => order({ items: [item(), second] }) });
    const inner = ctx.deps.insertGiftTx;
    ctx.deps.insertGiftTx = async (tx: TransactionSql, row: IssueGiftCertificateRow) => {
      if (row.issuedOrderItemId === second.id) throw new Error('bang');
      return inner(tx, row);
    };

    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.issued).toBe(1);
    expect(report.failed).toBe(1);
    expect(ctx.inserted).toHaveLength(1);
    expect(ctx.txCalls).toHaveLength(2);
  });

  it('берёт advisory-lock по заказу перед выпуском', async () => {
    const ctx = makeDeps();
    await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(ctx.locked).toEqual([ORDER_ID]);
  });

  it('НИКОГДА не бросает наружу: падение БД → отчёт с ok=false (вебхук не откатит оплату)', async () => {
    const { deps } = makeDeps({
      getOrderForAutoIssue: async () => {
        throw new Error('connection terminated');
      },
    });
    const report = await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('error');
  });

  it('падение транзакции позиции ловится: отчёт failed, исключения нет', async () => {
    const { deps } = makeDeps({
      withTransaction: async () => {
        throw new Error('deadlock detected');
      },
    });
    const report = await createGiftAutoIssuer(deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.failed).toBe(1);
    expect(report.issued).toBe(0);
    expect(report.ok).toBe(false);
  });

  it('заказ не оплачен → ничего не выпускает', async () => {
    const ctx = makeDeps({
      getOrderForAutoIssue: async () => order({ paymentStatus: 'pending', status: 'new', paidAt: null }),
    });
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.reason).toBe('order_not_paid');
    expect(ctx.inserted).toHaveLength(0);
  });

  it('заказ cancelled/refunded → ничего не выпускает даже при payment_status=paid', async () => {
    for (const status of ['cancelled', 'refunded'] as const) {
      const ctx = makeDeps({ getOrderForAutoIssue: async () => order({ status }) });
      const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
      expect(report.reason).toBe('order_not_eligible');
      expect(ctx.inserted).toHaveLength(0);
    }
  });

  it('автовыпуск выключен настройкой → ничего не выпускает', async () => {
    const ctx = makeDeps({ getGiftSettings: async () => ({ ...SETTINGS_ON, autoIssue: false }) });
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.reason).toBe('auto_issue_disabled');
    expect(ctx.inserted).toHaveLength(0);
  });

  it('заказ оплачен САМИМ сертификатом → по умолчанию не выпускаем (анти-«вечные деньги»)', async () => {
    const ctx = makeDeps({ getOrderForAutoIssue: async () => order({ giftCertificateId: 'g-1' }) });
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.reason).toBe('paid_with_gift');
    expect(ctx.inserted).toHaveLength(0);

    const allowed = makeDeps({
      getOrderForAutoIssue: async () => order({ giftCertificateId: 'g-1' }),
      getGiftSettings: async () => ({ ...SETTINGS_ON, allowIssueOnGiftPaidOrder: true }),
    });
    const ok = await createGiftAutoIssuer(allowed.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(ok.issued).toBe(1);
  });

  it('заказ без позиций-сертификатов → no-op без транзакций', async () => {
    const ctx = makeDeps({
      getOrderForAutoIssue: async () =>
        order({ items: [item({ nameSnapshot: 'Платок', attributesSnapshot: {} })] }),
    });
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.reason).toBe('no_gift_items');
    expect(ctx.txCalls).toHaveLength(0);
  });

  it('заказ не найден → отчёт order_not_found, без исключения', async () => {
    const ctx = makeDeps({ getOrderForAutoIssue: async () => null });
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(report.reason).toBe('order_not_found');
  });

  it('отчёт НЕ содержит сам код: код на деньги отдаётся только по токену заказа', async () => {
    const ctx = makeDeps();
    const report = await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    const issuedCode = ctx.inserted[0]!.code;
    expect(JSON.stringify(report)).not.toContain(issuedCode);
    expect(report.items[0]!.certificateId).toBe('cert-1');
  });

  it('в аргументы логгера код не попадает ни при выпуске, ни при ошибке', async () => {
    const ctx = makeDeps();
    await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    const issuedCode = ctx.inserted[0]!.code;
    expect(ctx.logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.logged)).not.toContain(issuedCode);
    expect(JSON.stringify(ctx.logged)).not.toContain(issuedCode.replace(/-/g, ''));
  });

  it('не вызывает вызывающего повторно: getOrderForAutoIssue читается один раз на заказ', async () => {
    const spy = vi.fn(async () => order());
    const ctx = makeDeps({ getOrderForAutoIssue: spy });
    await createGiftAutoIssuer(ctx.deps).autoIssueGiftsForPaidOrder(ORDER_ID);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
