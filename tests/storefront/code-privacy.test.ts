import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  publicPromoReason,
  publicGiftReason,
  CODE_REJECTED_REASON,
} from '@/lib/storefront/code-privacy';
import { PROMO_REJECT_REASONS, GIFT_REJECT_REASONS } from '@/lib/storefront/error-reasons';
import { toQuoteDto } from '@/lib/storefront/order-dto';
import { toGiftQuoteDto } from '@/lib/storefront/gift-dto';
import { PROMO_REASON_MESSAGE, type PromoRejectReason } from '@/lib/orders/promo';

/**
 * ДЕФЕКТ (minor, безопасность): ОРАКУЛ СУЩЕСТВОВАНИЯ КОДОВ.
 *
 * /cart/quote отдавал ТОЧНУЮ причину отказа кода:
 *   NOSUCHCODE999 → 'not_found'   (кода нет)
 *   SUMMER-2025   → 'expired'     ← подтверждает, что код СУЩЕСТВУЕТ
 *   erokhina_style→ 'inactive'    ← подтверждает, что код СУЩЕСТВУЕТ
 * То же для сертификатов через giftCertificateCode. Разница ответов — рабочий
 * оракул: перебор словаря промокодов и УГАДЫВАНИЕ кодов сертификатов, а
 * сертификат — деньги на предъявителя (bearer): угадал код — унёс баланс.
 *
 * Образец правильного подхода в проекте: маршрут заказа намеренно склеивает
 * «нет заказа» и «нет доступа» (app/api/storefront/v1/orders/[number]/route.ts),
 * чтобы перебор номеров ничего не различал. Здесь — то же для кодов.
 *
 * ГРАНИЦА РЕДАКТИРОВАНИЯ — ПУБЛИЧНЫЙ DTO, а не домен: точная причина остаётся
 * внутри (логи, админка, аналитика), наружу уезжает ОДНА склеенная причина.
 */

const ROOT = resolve(__dirname, '../..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

// =============================================================================
// (а) Склейка причин: наружу — одно значение, что бы ни было внутри.
// =============================================================================
describe('publicPromoReason — оракул существования промокода закрыт', () => {
  it('🔴 «нет кода» и «код есть, но истёк/неактивен» неразличимы снаружи', () => {
    const notFound = publicPromoReason('not_found');
    expect(publicPromoReason('expired')).toBe(notFound);
    expect(publicPromoReason('inactive')).toBe(notFound);
    expect(publicPromoReason('not_started')).toBe(notFound);
    expect(publicPromoReason('usage_limit_reached')).toBe(notFound);
    expect(publicPromoReason('per_customer_limit_reached')).toBe(notFound);
    expect(publicPromoReason('invalid_kind')).toBe(notFound);
    expect(publicPromoReason('below_min_total')).toBe(notFound);
    expect(publicPromoReason('below_min_qty')).toBe(notFound);
  });

  it('склеенная причина — единственное значение публичного алфавита промокода', () => {
    for (const r of PROMO_REJECT_REASONS) {
      expect(publicPromoReason(r), r).toBe(CODE_REJECTED_REASON);
    }
    expect([...PROMO_REJECT_REASONS]).toEqual([CODE_REJECTED_REASON]);
  });

  it('применённый промокод (reason=null) остаётся null — успех не редактируется', () => {
    expect(publicPromoReason(null)).toBeNull();
    expect(publicPromoReason(undefined)).toBeNull();
  });

  it('неизвестное/будущее значение тоже склеивается (fail-closed по умолчанию)', () => {
    expect(publicPromoReason('some_new_domain_reason')).toBe(CODE_REJECTED_REASON);
  });
});

describe('publicGiftReason — оракул существования сертификата закрыт', () => {
  it('🔴 «нет сертификата» и «есть, но истёк/исчерпан/отключён» неразличимы', () => {
    const notFound = publicGiftReason('not_found');
    expect(publicGiftReason('expired')).toBe(notFound);
    expect(publicGiftReason('depleted')).toBe(notFound);
    expect(publicGiftReason('disabled')).toBe(notFound);
    expect(publicGiftReason('inactive')).toBe(notFound);
  });

  it('no_amount_due СОХРАНЯЕТСЯ: он про КОРЗИНУ, а не про существование кода', () => {
    // Покупатель уже подтвердил владение валидным кодом (иначе сюда не дойти):
    // «сертификату нечего покрывать» — состояние ЗАКАЗА, оракулом не является,
    // и склейка сломала бы полезную обратную связь (аудит: не убирать UX).
    expect(publicGiftReason('no_amount_due')).toBe('no_amount_due');
  });

  it('применённый сертификат (reason=null) остаётся null', () => {
    expect(publicGiftReason(null)).toBeNull();
  });

  it('публичный алфавит сертификата — только склейка + no_amount_due', () => {
    expect([...GIFT_REJECT_REASONS].sort()).toEqual([CODE_REJECTED_REASON, 'no_amount_due'].sort());
  });
});

// =============================================================================
// (б) Редактирование ПРИМЕНЕНО на границе DTO (не только функция существует).
// =============================================================================
describe('DTO /cart/quote не выпускает точную причину наружу', () => {
  const quote = {
    itemsTotal: '1000.00',
    discount: '0.00',
    deliveryCost: '0.00',
    grandTotal: '1000.00',
    lines: [],
    promo: { applied: false, code: 'SUMMER-2025', discount: '0.00' },
    delivery: { free: false, freeThresholdMet: false, cost: '0.00' },
  } as unknown as Parameters<typeof toQuoteDto>[0]['quote'];

  it('🔴 promoReason=expired (код существует) → наружу склеенная причина', () => {
    const dto = toQuoteDto({
      quote,
      currency: 'RUB',
      fulfillable: true,
      promoReason: 'expired',
      issues: [],
    });
    expect(dto.promo.reason).toBe(CODE_REJECTED_REASON);
    expect(dto.promo.reason).not.toBe('expired');
  });

  it('promoReason=not_found даёт РОВНО ТО ЖЕ значение (неразличимость)', () => {
    const mk = (reason: string) =>
      toQuoteDto({ quote, currency: 'RUB', fulfillable: true, promoReason: reason, issues: [] })
        .promo.reason;
    expect(mk('not_found')).toBe(mk('expired'));
    expect(mk('not_found')).toBe(mk('inactive'));
  });

  it('🔴 gift.reason=depleted (сертификат существует) → склеенная причина', () => {
    const dto = toGiftQuoteDto({
      applied: false,
      code: 'GIFT-XXXX',
      appliedAmount: '0.00',
      balanceRemainingAfter: '0.00',
      reason: 'depleted',
    });
    expect(dto?.reason).toBe(CODE_REJECTED_REASON);
  });

  it('сертификат: «не найден» и «исчерпан» неразличимы в DTO', () => {
    const mk = (reason: string | null) =>
      toGiftQuoteDto({
        applied: false,
        code: 'G',
        appliedAmount: '0.00',
        balanceRemainingAfter: '0.00',
        reason,
      })?.reason;
    expect(mk('not_found')).toBe(mk('depleted'));
    expect(mk('not_found')).toBe(mk('expired'));
    expect(mk('not_found')).toBe(mk('disabled'));
  });

  it('DTO не раскрывает баланс: applied=false → нулевой остаток, без номинала', () => {
    const dto = toGiftQuoteDto({
      applied: false,
      code: 'G',
      appliedAmount: '0.00',
      balanceRemainingAfter: '0.00',
      reason: 'depleted',
    })!;
    expect(Object.keys(dto).sort()).toEqual(
      ['applied', 'appliedAmount', 'balanceRemainingAfter', 'code', 'reason'].sort(),
    );
  });
});

// =============================================================================
// (в) UX не сломан: покупатель по-прежнему получает понятное сообщение.
// =============================================================================
describe('полезная обратная связь сохранена (склеена ПРИЧИНА, не сообщение)', () => {
  it('витрина умеет перевести склеенную причину в человеческий текст', () => {
    const ce = src('storefront/lib/checkout-errors.ts');
    expect(ce).toContain(CODE_REJECTED_REASON);
  });

  it('домен по-прежнему знает ТОЧНУЮ причину (логи/админка не ослаблены)', () => {
    // Склейка живёт на границе DTO, а не в домене: PROMO_REASON_MESSAGE полон.
    const domainReasons: PromoRejectReason[] = ['not_found', 'expired', 'inactive'];
    for (const r of domainReasons) expect(PROMO_REASON_MESSAGE[r]).toBeTruthy();
    expect(PROMO_REASON_MESSAGE.expired).not.toBe(PROMO_REASON_MESSAGE.not_found);
  });
});

// =============================================================================
// (г) Guard: редактирование нельзя обойти мимо DTO.
// =============================================================================
describe('guard: точная причина не течёт в обход редактора', () => {
  it('toQuoteDto пропускает promoReason через publicPromoReason', () => {
    const dto = src('lib/storefront/order-dto.ts');
    expect(dto).toContain('publicPromoReason');
    // Антипаттерн: сырой проброс причины наружу.
    expect(dto).not.toMatch(/reason:\s*input\.promoReason\s*\?\?\s*null/);
  });

  it('toGiftQuoteDto пропускает reason через publicGiftReason', () => {
    const dto = src('lib/storefront/gift-dto.ts');
    expect(dto).toContain('publicGiftReason');
    expect(dto).not.toMatch(/reason:\s*gift\.reason,/);
  });

  it('роут /cart/quote отдаёт DTO, а не собственную сборку причины', () => {
    const route = src('app/api/storefront/v1/cart/quote/route.ts');
    expect(route).toContain('toQuoteDto');
  });
});
