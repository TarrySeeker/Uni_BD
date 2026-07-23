import { describe, it, expect } from 'vitest';

import { formatPrice } from '@/lib/admin/format';
import {
  giftRefundWarnings,
  maskGiftCode,
  type IssuedGiftWarningInput,
} from '@/lib/gift-certificates/warnings';

/**
 * Юниты предупреждений менеджеру о возврате заказа с выпущенными сертификатами
 * (ТЗ п.11, трек T5). Чистая логика — без БД и React.
 */

function cert(over: Partial<IssuedGiftWarningInput> = {}): IssuedGiftWarningInput {
  return {
    code: 'GIFT-AAAA-1234',
    spentTotal: '0.00',
    currency: 'RUB',
    status: 'active',
    ...over,
  };
}

describe('maskGiftCode', () => {
  it('оставляет только хвост кода — целиком код в лог не уходит', () => {
    expect(maskGiftCode('GIFT-AAAA-1234')).toBe('•••1234');
    expect(maskGiftCode('GIFT-AAAA-1234')).not.toContain('AAAA');
  });

  it('короткий/пустой код маскируется полностью', () => {
    expect(maskGiftCode('AB')).toBe('••••');
    expect(maskGiftCode('   ')).toBe('••••');
  });
});

describe('giftRefundWarnings — превентивно, до возврата', () => {
  it('есть потраченное → предупреждение с суммой и словом «не вернётся»', () => {
    const out = giftRefundWarnings([cert({ spentTotal: '1500.50' })], { kind: 'preventive' });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(formatPrice('1500.50', 'RUB'));
    expect(out[0]).toContain('погашены');
    expect(out[0]).toContain('не вернётся');
  });

  it('ноль потраченного → предупреждения ПРО ПОТРАЧЕННОЕ нет', () => {
    const out = giftRefundWarnings([cert({ spentTotal: '0.00' })], { kind: 'preventive' });
    expect(out.join(' ')).not.toContain('потрачено');
    expect(out.join(' ')).not.toContain('не вернётся');
    // но факт «коды будут погашены» сообщить обязаны
    expect(out.join(' ')).toContain('погашен');
  });

  it('несколько кодов — потраченное суммируется, количество названо', () => {
    const out = giftRefundWarnings(
      [
        cert({ code: 'A-1111', spentTotal: '1000.00' }),
        cert({ code: 'B-2222', spentTotal: '250.25', status: 'depleted' }),
        cert({ code: 'C-3333', spentTotal: '0.00' }),
      ],
      { kind: 'preventive' },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(formatPrice('1250.25', 'RUB'));
    expect(out[0]).toContain('3 шт.');
  });

  it('уже погашенные (disabled) в превентивный подсчёт не попадают', () => {
    const out = giftRefundWarnings(
      [cert({ spentTotal: '900.00', status: 'disabled' })],
      { kind: 'preventive' },
    );
    expect(out).toEqual([]);
  });

  it('истёкшие не гасятся возвратом (revokeIssuedGiftsTx их не трогает) — не пугаем', () => {
    const out = giftRefundWarnings(
      [cert({ spentTotal: '900.00', status: 'expired' })],
      { kind: 'preventive' },
    );
    expect(out).toEqual([]);
  });

  it('разные валюты не складываются в одну сумму', () => {
    const out = giftRefundWarnings(
      [
        cert({ code: 'A-1', spentTotal: '100.00', currency: 'RUB' }),
        cert({ code: 'B-2', spentTotal: '20.00', currency: 'EUR' }),
      ],
      { kind: 'preventive' },
    );
    expect(out[0]).toContain(formatPrice('100.00', 'RUB'));
    expect(out[0]).toContain(formatPrice('20.00', 'EUR'));
  });

  it('пустой список — молчим', () => {
    expect(giftRefundWarnings([])).toEqual([]);
  });
});

describe('giftRefundWarnings — постфактум, код уже погашен', () => {
  it('погашенный с потраченным → «погашен, потрачено было N»', () => {
    const out = giftRefundWarnings(
      [cert({ code: 'GIFT-ZZZZ-9876', spentTotal: '300.00', status: 'disabled' })],
      { kind: 'revoked', revealCode: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('GIFT-ZZZZ-9876');
    expect(out[0]).toContain('погашен');
    expect(out[0]).toContain('потрачено было');
    expect(out[0]).toContain(formatPrice('300.00', 'RUB'));
  });

  it('погашенный без потраченного → про потраченное ни слова', () => {
    const out = giftRefundWarnings(
      [cert({ spentTotal: '0.00', status: 'disabled' })],
      { kind: 'revoked' },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('погашен');
    expect(out[0]).not.toContain('потрачено');
  });

  it('по умолчанию код МАСКИРУЕТСЯ (сообщение может уйти в лог)', () => {
    const out = giftRefundWarnings(
      [cert({ code: 'GIFT-SECRET-4242', spentTotal: '10.00', status: 'disabled' })],
      { kind: 'revoked' },
    );
    expect(out[0]).not.toContain('SECRET');
    expect(out[0]).toContain('4242');
  });

  it('несколько погашенных → по строке на каждый', () => {
    const out = giftRefundWarnings(
      [
        cert({ code: 'A-1111', spentTotal: '10.00', status: 'disabled' }),
        cert({ code: 'B-2222', spentTotal: '0.00', status: 'disabled' }),
      ],
      { kind: 'revoked', revealCode: true },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('A-1111');
    expect(out[1]).toContain('B-2222');
  });
});

describe('giftRefundWarnings — устойчивость и режим по умолчанию', () => {
  it('без kind возвращает и превентивные, и постфактумные', () => {
    const out = giftRefundWarnings([
      cert({ code: 'A-1111', spentTotal: '100.00', status: 'active' }),
      cert({ code: 'B-2222', spentTotal: '50.00', status: 'disabled' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.join(' ')).toContain('не вернётся');
    expect(out.join(' ')).toContain('потрачено было');
  });

  it('битые суммы не роняют функцию (UI-подсказка не должна падать)', () => {
    expect(() =>
      giftRefundWarnings([cert({ spentTotal: 'нет данных' }), cert({ spentTotal: '' })]),
    ).not.toThrow();
  });
});
