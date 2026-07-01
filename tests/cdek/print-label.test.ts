import { describe, it, expect } from 'vitest';

import {
  MOCK_LABEL_NOTICE,
  resolveLabelOutcome,
} from '@/lib/cdek/print-label';

/**
 * Находка #12: в mock-режиме печать вела на мёртвый example.invalid. Чистая
 * функция исхода печати — UI открывает вкладку ТОЛЬКО в боевом режиме с URL,
 * а в mock показывает пояснение и НЕ открывает ничего.
 */
describe('resolveLabelOutcome (печать накладной/ШК)', () => {
  it('mock → не открывать вкладку, показать пояснение про боевой режим', () => {
    const out = resolveLabelOutcome('Печать накладной', {
      isMock: true,
      url: 'https://example.invalid/mock-waybill.pdf',
    });
    expect(out.open).toBe(false);
    expect(out.message).toContain(MOCK_LABEL_NOTICE);
    // Гарантия: дефект (открытие example.invalid) устранён — вкладку не открываем.
    expect(out.open).not.toBe(true);
  });

  it('боевой режим + готовый URL → открыть вкладку, «выполнено»', () => {
    const out = resolveLabelOutcome('Печать ШК', {
      isMock: false,
      url: 'https://cdek.ru/print/abc.pdf',
    });
    expect(out.open).toBe(true);
    expect(out.message).toBe('Печать ШК: выполнено.');
  });

  it('боевой режим без URL → не открывать, но «выполнено»', () => {
    const out = resolveLabelOutcome('Печать накладной', { isMock: false, url: null });
    expect(out.open).toBe(false);
    expect(out.message).toBe('Печать накладной: выполнено.');
  });
});
