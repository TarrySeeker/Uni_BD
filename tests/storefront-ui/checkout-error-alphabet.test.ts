import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  STOREFRONT_ERROR_REASONS,
  CART_ITEM_ISSUE_REASONS,
  PROMO_REJECT_REASONS,
  GIFT_REJECT_REASONS,
} from '@/lib/storefront/error-reasons';

import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';
import {
  ORDER_ERROR_REASONS as SF_ORDER_REASONS,
  CART_ITEM_ISSUE_REASONS as SF_ITEM_REASONS,
  PROMO_REJECT_REASONS as SF_PROMO_REASONS,
  GIFT_REJECT_REASONS as SF_GIFT_REASONS,
  issueLabel,
  promoReasonLabel,
  giftReasonLabel,
  orderErrorLabel,
} from '../../storefront/lib/checkout-errors';
import { ApiError } from '../../storefront/lib/api';

/**
 * ГРУППА A аудита (№3, №6 + связанные №15/№16): доменный код отказа терялся по
 * дороге к витрине, а домен и словарь витрины ещё и говорили на РАЗНЫХ наборах
 * значений (промокод: 8 доменных против 7 «своих» на витрине, совпадали 3).
 *
 * Здесь фиксируется ЕДИНЫЙ публичный алфавит: сервер (lib/storefront/error-reasons)
 * и витрина (storefront/lib/checkout-errors) обязаны перечислять ОДИН И ТОТ ЖЕ
 * набор, и каждый его член обязан резолвиться в человеческий текст во ВСЕХ трёх
 * локалях — без сырого кода и без серверной русской строки.
 */

const LOCALES: Locale[] = ['ru', 'en', 'fr'];
const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/**
 * Подпись обязана быть ЧЕЛОВЕЧЕСКОЙ: не равна машинному коду и не содержит
 * снейк-кейс-токена (сырой код вида out_of_stock/below_min_qty в тексте для
 * покупателя недопустим ни в одной локали).
 */
function expectHuman(label: string, code: string): void {
  expect(label, code).toBeTruthy();
  expect(label, code).not.toBe(code);
  expect(label, code).not.toMatch(/[a-z]+_[a-z_]+/);
}

describe('алфавиты сервера и витрины сведены', () => {
  it('причины отказа создания заказа совпадают', () => {
    expect(sorted(SF_ORDER_REASONS)).toEqual(sorted(STOREFRONT_ERROR_REASONS));
  });

  it('причины недоступности позиции совпадают', () => {
    expect(sorted(SF_ITEM_REASONS)).toEqual(sorted(CART_ITEM_ISSUE_REASONS));
  });

  it('причины отказа промокода совпадают', () => {
    expect(sorted(SF_PROMO_REASONS)).toEqual(sorted(PROMO_REJECT_REASONS));
  });

  it('причины отказа сертификата совпадают', () => {
    expect(sorted(SF_GIFT_REASONS)).toEqual(sorted(GIFT_REJECT_REASONS));
  });
});

describe.each(LOCALES)('локаль %s — каждый доменный код резолвится в текст', (locale) => {
  const t = getDictionary(locale).checkout;

  it('позиции: каждый код даёт СВОЙ текст, а не общий фолбэк', () => {
    for (const code of SF_ITEM_REASONS) {
      expectHuman(issueLabel(t, code), code);
    }
    // Разные причины — разные подписи (иначе перевод не несёт смысла).
    const labels = SF_ITEM_REASONS.map((c) => issueLabel(t, c));
    expect(new Set(labels).size).toBe(SF_ITEM_REASONS.length);
  });

  it('промокод: каждый код даёт СВОЙ текст, а не общий «не применён»', () => {
    for (const reason of SF_PROMO_REASONS) {
      const label = promoReasonLabel(t, reason);
      expectHuman(label, reason);
      expect(label, reason).not.toBe(t.promoNotApplied);
    }
  });

  it('сертификат: каждый код даёт СВОЙ текст, а не общий «не применён»', () => {
    for (const reason of SF_GIFT_REASONS) {
      const label = giftReasonLabel(t, reason);
      expectHuman(label, reason);
      expect(label, reason).not.toBe(t.giftCodeNotApplied);
    }
  });

  it('ошибка оформления: доменная причина резолвится, транспортный код — нет', () => {
    for (const reason of SF_ORDER_REASONS) {
      const label = orderErrorLabel(t, { code: 'unprocessable', reason });
      expect(label, reason).toBeTruthy();
      expectHuman(label ?? '', reason);
    }
  });

  it('неизвестный код (в т.ч. голый транспортный) → null, а не сырое значение', () => {
    expect(orderErrorLabel(t, { code: 'unprocessable' })).toBeNull();
    expect(orderErrorLabel(t, { code: 'conflict' })).toBeNull();
    expect(orderErrorLabel(t, { code: 'whatever_new', reason: 'whatever_new' })).toBeNull();
    expect(orderErrorLabel(t, null)).toBeNull();
  });

  it('транспортные коды со своим текстом (network/rate_limited) работают как раньше', () => {
    expect(orderErrorLabel(t, { code: 'network' })).toBe(t.orderErrorNetwork);
    expect(orderErrorLabel(t, { code: 'rate_limited' })).toBe(t.orderErrorRateLimited);
  });

  it('доменная причина ПРИОРИТЕТНЕЕ транспортного кода', () => {
    // 409 conflict + reason out_of_stock: показываем «нет остатка», не общий текст.
    expect(orderErrorLabel(t, { code: 'conflict', reason: 'out_of_stock' })).toBe(
      t.orderErrorOutOfStock,
    );
  });
});

describe('ApiError несёт доменную причину рядом с транспортным кодом', () => {
  it('reason читается из тела ответа, code остаётся транспортным', () => {
    const err = new ApiError(422, {
      code: 'unprocessable',
      message: 'Подарочный сертификат не найден.',
      reason: 'invalid_gift',
    });
    expect(err.code).toBe('unprocessable');
    expect(err.reason).toBe('invalid_gift');
  });

  it('старый ответ без reason не ломается', () => {
    const err = new ApiError(409, { code: 'conflict', message: 'x' });
    expect(err.code).toBe('conflict');
    expect(err.reason).toBeUndefined();
  });
});

describe('GUARD: сырой код и серверный текст не рендерятся покупателю', () => {
  const form = read('storefront/app/[lang]/cart/order/CheckoutForm.tsx');

  it('CheckoutForm берёт подписи ТОЛЬКО из общего модуля переводов ошибок', () => {
    expect(form).toContain("from '@/lib/checkout-errors'");
    // Локальных карт кодов в компоненте больше нет.
    expect(form).not.toMatch(/function\s+(issueLabel|promoReasonLabel|giftReasonLabel)\s*\(/);
  });

  it('err.message никогда не попадает в состояние ошибки формы', () => {
    expect(form).not.toMatch(/set(Quote|Submit)Error\([^)]*\.message/);
    expect(form).not.toMatch(/\?\?\s*err\.message/);
    expect(form).not.toMatch(/\?\?\s*(err\.)?code\b/);
  });

  it('роут заказов отдаёт доменную причину наружу', () => {
    const route = read('app/api/storefront/v1/orders/route.ts');
    expect(route).toContain('jsonDomainError');
    expect(route).toContain('result.code');
    // Транспортный код больше не выбирается вручную на месте.
    expect(route).not.toMatch(/jsonError\('unprocessable', result\.message/);
  });
});
