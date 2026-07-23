import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { toGiftQuoteDto } from '@/lib/storefront/gift-dto';

/**
 * ПЕРСДАННЫЕ (ТЗ п.7 + 0054): «кто купил» / «на чьё имя» — данные админки.
 * Публичный DTO витрины (lib/storefront/gift-dto.ts) не имеет права их отдавать:
 * сертификат — бирер-инструмент, код может предъявить кто угодно, и по коду
 * нельзя узнать ФИО/почту/телефон покупателя или получателя.
 *
 * (а) фактическая проверка: набор ключей DTO — ровно белый список;
 * (б) guard по исходнику: в модуле НЕТ обращений к полям сторон сделки.
 */

const DTO_PATH = path.join(process.cwd(), 'lib/storefront/gift-dto.ts');
const SRC = readFileSync(DTO_PATH, 'utf8');

/** Единственные поля, которые витрина имеет право видеть. */
const PUBLIC_KEYS = ['applied', 'code', 'appliedAmount', 'balanceRemainingAfter', 'reason'];

describe('storefront gift DTO — персданные не утекают (факт)', () => {
  it('DTO отдаёт РОВНО белый список ключей', () => {
    const dto = toGiftQuoteDto({
      applied: true,
      code: 'GIFT500',
      appliedAmount: '500.00',
      balanceRemainingAfter: '0.00',
      reason: null,
    });
    expect(dto).not.toBeNull();
    expect(Object.keys(dto!).sort()).toEqual([...PUBLIC_KEYS].sort());
  });

  it('лишние поля источника (в т.ч. персональные) в DTO не переносятся', () => {
    const dto = toGiftQuoteDto({
      applied: true,
      code: 'GIFT500',
      appliedAmount: '500.00',
      balanceRemainingAfter: '0.00',
      reason: null,
      // Симулируем «протёкший» домен: если маппер начнёт делать {...gift},
      // эти ключи окажутся в DTO и тест упадёт.
      purchaser: { name: 'Иван', email: 'ivan@shop.io', phone: '+7999' },
      recipient: { name: 'Мария', email: 'm@shop.io', phone: null },
      purchaserCustomerId: 'cust-1',
    } as never);
    expect(Object.keys(dto!).sort()).toEqual([...PUBLIC_KEYS].sort());
  });

  it('null → null (сертификат к корзине не применяли)', () => {
    expect(toGiftQuoteDto(null)).toBeNull();
  });
});

describe('storefront gift DTO — guard по исходнику', () => {
  it('модуль не упоминает поля сторон сделки и происхождения выпуска', () => {
    for (const token of [
      'purchaser',
      'recipient',
      'purchaserCustomerId',
      'issuedOrder',
      'issue_source',
      'issueSource',
    ]) {
      expect(SRC.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it('маппер собирает DTO ПОЛЕ ЗА ПОЛЕМ, а не спредом домена (антипаттерн)', () => {
    // Спред домена в DTO — самый вероятный путь утечки при добавлении колонок.
    expect(SRC).not.toMatch(/\.\.\.gift\b/);
    expect(SRC).not.toMatch(/return\s*\{\s*\.\.\./);
    for (const key of PUBLIC_KEYS) {
      expect(SRC).toContain(`${key}: gift.${key}`);
    }
  });
});
