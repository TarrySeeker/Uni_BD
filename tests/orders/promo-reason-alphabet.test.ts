import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { promoNotFound, PROMO_REASON_MESSAGE } from '@/lib/orders/promo';
import type { PromoRejectReason } from '@/lib/orders/promo';

/**
 * Находка аудита №15 (major): при НЕСУЩЕСТВУЮЩЕМ промокоде quoteCart подставлял
 * `reason:'inactive'` («Промокод неактивен») — покупатель видел «не применён» без
 * настоящей причины, а ключ словаря витрины `promoReasonNotFound` не выбирался
 * НИКОГДА. Причина «не найден» — самостоятельный член алфавита.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

describe('промокод: причина «не найден» — отдельный член алфавита', () => {
  it('promoNotFound() отдаёт reason=not_found с человеческим текстом', () => {
    const res = promoNotFound();
    expect(res.valid).toBe(false);
    if (res.valid) return;
    expect(res.reason).toBe('not_found');
    expect(res.message).toMatch(/не найден/i);
  });

  it('у КАЖДОЙ причины алфавита есть человеческое сообщение', () => {
    const reasons: PromoRejectReason[] = [
      'not_found',
      'inactive',
      'not_started',
      'expired',
      'below_min_total',
      'below_min_qty',
      'usage_limit_reached',
      'per_customer_limit_reached',
      'invalid_kind',
    ];
    for (const reason of reasons) {
      const msg = PROMO_REASON_MESSAGE[reason];
      expect(msg, reason).toBeTruthy();
      // Сырой машинный код в тексте для покупателя недопустим.
      expect(msg, reason).not.toContain(reason);
    }
  });

  it('репозиторий не подменяет «не найден» на «неактивен»', () => {
    const src = read('lib/orders/repository.ts');
    expect(src).toContain('promoNotFound()');
    // Старая подмена («кода нет» → «неактивен») исчезла из quoteCart. Причина
    // 'inactive' сама по себе легитимна — она остаётся у позиций корзины.
    expect(src).not.toMatch(/reason:\s*'inactive',\s*\n\s*message:\s*'Промокод/);
  });
});
