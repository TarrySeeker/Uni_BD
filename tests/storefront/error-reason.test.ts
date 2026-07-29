import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  STOREFRONT_ERROR_REASONS,
  CART_ITEM_ISSUE_REASONS,
  PROMO_REJECT_REASONS,
  GIFT_REJECT_REASONS,
  isStorefrontErrorReason,
  transportForReason,
  type StorefrontErrorReason,
} from '@/lib/storefront/error-reasons';
import type { CreateOrderResult } from '@/lib/orders/repository';
import type { PromoRejectReason } from '@/lib/orders/promo';
import type { CartLineIssueCode } from '@/lib/orders/cart-messages';

/**
 * ГРУППА A аудита (находки №3 и №6): сервер знал точную причину отказа
 * («нет остатка», «промокод недействителен», «доставка не рассчитана»), но
 * `jsonError` клал в тело ТРАНСПОРТНЫЙ код ('conflict'/'unprocessable'), а
 * доменный выбрасывал. Витрина получала ApiError.code='unprocessable', карта
 * переводов не срабатывала НИ РАЗУ, и покупателю на /en и /fr печатался русский
 * серверный текст.
 *
 * Контракт (аддитивное расширение, ломать `code` нельзя — он транспортный и на
 * него опираются другие тенанты): конверт ошибки получает НЕОБЯЗАТЕЛЬНОЕ поле
 * `reason` с доменным кодом из фиксированного публичного алфавита.
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;

async function load() {
  vi.resetModules();
  return import('@/lib/storefront/response');
}

describe('публичный алфавит доменных причин отказа', () => {
  it('алфавит непустой и без дублей', () => {
    expect(STOREFRONT_ERROR_REASONS.length).toBeGreaterThan(0);
    expect(new Set(STOREFRONT_ERROR_REASONS).size).toBe(STOREFRONT_ERROR_REASONS.length);
  });

  it('isStorefrontErrorReason отсекает чужие значения', () => {
    expect(isStorefrontErrorReason('out_of_stock')).toBe(true);
    expect(isStorefrontErrorReason('unprocessable')).toBe(false);
    expect(isStorefrontErrorReason('')).toBe(false);
    expect(isStorefrontErrorReason(null)).toBe(false);
  });

  it('нет остатка → 409 conflict, остальное → 422 unprocessable', () => {
    expect(transportForReason('out_of_stock')).toBe('conflict');
    expect(transportForReason('order_not_payable')).toBe('conflict');
    expect(transportForReason('invalid_promo')).toBe('unprocessable');
    expect(transportForReason('invalid_gift')).toBe('unprocessable');
    expect(transportForReason('delivery_unavailable')).toBe('unprocessable');
    expect(transportForReason('invalid_zone')).toBe('unprocessable');
    // Неизвестный ПВЗ — плохие данные тела, не конфликт состояния: покупателю
    // надо выбрать пункт заново, повтор того же запроса не поможет.
    expect(transportForReason('invalid_pvz')).toBe('unprocessable');
    expect(transportForReason('payments_disabled')).toBe('unprocessable');
    expect(transportForReason('invalid_item')).toBe('unprocessable');
    // Сумма разошлась — КОНФЛИКТ состояния: тело валидно, изменились цены/промокод/
    // остаток сертификата. Повтор того же запроса не поможет, нужен пересчёт.
    expect(transportForReason('total_mismatch')).toBe('conflict');
  });

  it('КАЖДЫЙ код отказа createOrder входит в алфавит (тип-уровневая сверка)', () => {
    type CreateErrCode = Extract<CreateOrderResult, { ok: false }>['code'];
    // Record требует ВСЕ ключи домена, значения обязаны быть членами алфавита —
    // расхождение ломает tsc, а не только этот assert.
    const cover: Record<CreateErrCode, StorefrontErrorReason> = {
      out_of_stock: 'out_of_stock',
      invalid_item: 'invalid_item',
      invalid_promo: 'invalid_promo',
      invalid_gift: 'invalid_gift',
      delivery_unavailable: 'delivery_unavailable',
      invalid_zone: 'invalid_zone',
      // Аудит major: прислан код ПВЗ, которого нет в справочнике службы —
      // раньше такой заказ создавался и был неотгружаем (накладную не создать).
      invalid_pvz: 'invalid_pvz',
      payments_disabled: 'payments_disabled',
      // Аудит №2/№9: показанный покупателю итог разошёлся с фактическим.
      total_mismatch: 'total_mismatch',
    };
    for (const reason of Object.values(cover)) {
      expect(STOREFRONT_ERROR_REASONS).toContain(reason);
    }
  });

  it('алфавит причин позиции совпадает с доменным union CartLineIssueCode', () => {
    const cover: Record<CartLineIssueCode, true> = {
      product_not_found: true,
      variant_not_found: true,
      inactive: true,
      out_of_stock: true,
    };
    expect([...CART_ITEM_ISSUE_REASONS].sort()).toEqual(Object.keys(cover).sort());
  });

  /**
   * 🔴 АУДИТ (безопасность, «оракул существования кодов»). ПУБЛИЧНЫЙ алфавит
   * причин отказа кода НАМЕРЕННО НЕ РАВЕН доменному: точные причины (not_found
   * против expired/inactive) прямо говорили, существует код или нет, и делали
   * /cart/quote оракулом для перебора промокодов и угадывания сертификатов
   * (bearer-инструмент). Домен точные причины СОХРАНЯЕТ (логи/админка) — это
   * проверяется ниже; наружу выпускается одно склеенное значение.
   */
  it('публичный алфавит промокода СКЛЕЕН и не раскрывает существование кода', () => {
    // Домен по-прежнему полон — тип-уровневая сверка (Record требует все ключи).
    const cover: Record<PromoRejectReason, true> = {
      not_found: true,
      inactive: true,
      not_started: true,
      expired: true,
      below_min_total: true,
      below_min_qty: true,
      usage_limit_reached: true,
      per_customer_limit_reached: true,
      invalid_kind: true,
    };
    expect(Object.keys(cover).length).toBeGreaterThan(1);
    // А публичный — ровно одно значение, и ни одна доменная причина в нём не
    // светится (иначе по её наличию/отсутствию снова читалось бы существование).
    expect([...PROMO_REJECT_REASONS]).toEqual(['not_applicable']);
    for (const domainReason of Object.keys(cover)) {
      expect(PROMO_REJECT_REASONS as readonly string[], domainReason).not.toContain(domainReason);
    }
  });

  it('публичный алфавит сертификата: склейка + причина про КОРЗИНУ', () => {
    // no_amount_due остаётся: он про состояние заказа («покрывать нечего»), а не
    // про существование кода — оракулом не является и нужен для UX.
    expect([...GIFT_REJECT_REASONS].sort()).toEqual(['no_amount_due', 'not_applicable'].sort());
    for (const leaky of ['not_found', 'expired', 'depleted', 'disabled']) {
      expect(GIFT_REJECT_REASONS as readonly string[], leaky).not.toContain(leaky);
    }
  });
});

describe('конверт ошибки Storefront API — доменный код доезжает до витрины', () => {
  beforeEach(() => {
    process.env.ADMIK_MODULES = 'catalog,orders';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
  });

  it('jsonError без reason — форма тела НЕ меняется (обратная совместимость)', async () => {
    const { jsonError } = await load();
    const res = jsonError('bad_request', 'Плохое тело.', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Плохое тело.');
    expect('reason' in body.error).toBe(false);
  });

  it('jsonError с reason кладёт доменный код РЯДОМ с транспортным, не подменяя его', async () => {
    const { jsonError } = await load();
    const res = jsonError('conflict', 'Недостаточно остатка.', {}, {}, 'out_of_stock');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.reason).toBe('out_of_stock');
  });

  it('jsonDomainError сам выбирает транспорт по доменной причине', async () => {
    const { jsonDomainError } = await load();

    const stock = jsonDomainError('out_of_stock', 'Недостаточно остатка.', {});
    expect(stock.status).toBe(409);
    const stockBody = (await stock.json()) as { error: { code: string; reason?: string } };
    expect(stockBody.error.code).toBe('conflict');
    expect(stockBody.error.reason).toBe('out_of_stock');

    const promo = jsonDomainError('invalid_promo', 'Промокод не найден.', {});
    expect(promo.status).toBe(422);
    const promoBody = (await promo.json()) as { error: { code: string; reason?: string } };
    expect(promoBody.error.code).toBe('unprocessable');
    expect(promoBody.error.reason).toBe('invalid_promo');
  });

  it('CORS-заголовки и extraHeaders сохраняются вместе с reason', async () => {
    const { jsonError } = await load();
    const res = jsonError(
      'conflict',
      'x',
      { 'Access-Control-Allow-Origin': '*' },
      { 'Retry-After': '30' },
      'out_of_stock',
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Retry-After')).toBe('30');
  });
});
