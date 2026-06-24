import { describe, it, expect } from 'vitest';
import { cartLineIssueMessage } from '@/lib/orders/cart-messages';

describe('cartLineIssueMessage', () => {
  it('маппит известные коды в понятный покупателю текст (без сырого кода)', () => {
    expect(cartLineIssueMessage('product_not_found')).toBe('Товар больше недоступен');
    expect(cartLineIssueMessage('variant_not_found')).toBe('Выбранный вариант товара недоступен');
    expect(cartLineIssueMessage('inactive')).toBe('Товар больше не продаётся');
    expect(cartLineIssueMessage('out_of_stock')).toBe('Недостаточно товара на складе');
  });

  it('не содержит технических кодов в тексте', () => {
    for (const code of ['product_not_found', 'variant_not_found', 'inactive', 'out_of_stock']) {
      expect(cartLineIssueMessage(code)).not.toMatch(/_|out_of|not_found|inactive/);
    }
  });

  it('неизвестный код → нейтральный текст без утечки кода', () => {
    expect(cartLineIssueMessage('weird_code')).toBe('Позиция недоступна');
    expect(cartLineIssueMessage('weird_code')).not.toContain('weird_code');
  });
});
