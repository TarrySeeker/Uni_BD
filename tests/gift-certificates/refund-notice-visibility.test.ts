import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { SYSTEM_ROLES } from '@/lib/auth/permissions';
import { giftRefundWarnings } from '@/lib/gift-certificates/warnings';

/**
 * Находка №22 — «Менеджер» делает возврат, молча гасящий выпущенные коды на
 * предъявителя, и НЕ видит предупреждения (у роли нет gift.read).
 *
 * РЕШЕНИЕ (безопасный вариант из двух предложенных): право gift.read менеджеру
 * НЕ выдаём — код сертификата предъявительский секрет, а роль «Менеджер»
 * операционная. Вместо этого ПРЕДУПРЕЖДЕНИЕ о гашении отвязано от gift.read:
 * его видит любой, у кого есть orders.write (то есть тот, кто способен нажать
 * «Возврат»), но БЕЗ раскрытия кода — коды маскируются (maskGiftCode).
 *
 * Инвариант: «сколько кодов погаснет и сколько уже потрачено» — не секрет;
 * «какой именно код» — секрет.
 */

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const ORDER_PAGE = src('app/admin/(panel)/orders/[id]/page.tsx');

describe('№22 — право gift.read менеджеру НЕ выдано (код остаётся секретом)', () => {
  const manager = SYSTEM_ROLES.find((r) => r.code === 'manager')!;
  const admin = SYSTEM_ROLES.find((r) => r.code === 'admin')!;

  it('🔴 менеджер по-прежнему без gift.read и gift.write', () => {
    expect(manager.permissions).not.toContain('gift.read');
    expect(manager.permissions).not.toContain('gift.write');
  });

  it('администратор права сохраняет (инвариант полноты роли admin)', () => {
    expect(admin.permissions).toContain('gift.read');
    expect(admin.permissions).toContain('gift.write');
  });

  it('менеджер по-прежнему может делать возврат (orders.write)', () => {
    expect(manager.permissions).toContain('orders.write');
  });
});

describe('№22 — предупреждение о гашении кодов видно и без gift.read', () => {
  it('🔴 карточка заказа читает выпущенные коды для предупреждения независимо от gift.read', () => {
    // Раньше: issuedCerts = showGift ? … : [] → у менеджера предупреждение пустое.
    expect(ORDER_PAGE).not.toMatch(/issuedCerts\s*=\s*showGift\s*\?/);
    // Предупреждение строится из тех же данных, но гейтится правом ЗАПИСИ заказа.
    expect(ORDER_PAGE).toContain('giftRefundNotice');
    expect(ORDER_PAGE).toContain('revealCode: showGift');
  });

  it('🔴 сам БЛОК сертификатов (где виден код целиком) по-прежнему за gift.read', () => {
    expect(ORDER_PAGE).toContain("can(guard.user, 'gift.read')");
    expect(ORDER_PAGE).toMatch(/\{showGift \? \(\s*<GiftIssueBlock/);
  });

  it('🔴 код применённого к оплате сертификата по-прежнему только при gift.read', () => {
    expect(ORDER_PAGE).toMatch(/order\.giftCertificateId && showGift/);
  });
});

describe('№22 — маскирование кода в предупреждении (revealCode=false)', () => {
  const issued = [
    { code: 'ABCD-EFGH-JKMN-PQRS', spentTotal: '1200.00', currency: 'RUB', status: 'disabled' as const },
  ];

  it('без gift.read код замаскирован, но факт гашения и сумма видны', () => {
    const [msg] = giftRefundWarnings(issued, { kind: 'revoked', revealCode: false });
    expect(msg).toBeDefined();
    expect(msg).not.toContain('ABCD-EFGH-JKMN-PQRS');
    expect(msg).toContain('PQRS');
    expect(msg).toMatch(/1[\s  ]?200/);
  });

  it('с gift.read код печатается целиком (администратору он нужен)', () => {
    const [msg] = giftRefundWarnings(issued, { kind: 'revoked', revealCode: true });
    expect(msg).toContain('ABCD-EFGH-JKMN-PQRS');
  });

  it('превентивное предупреждение кодов не содержит вовсе — только количество и сумму', () => {
    const [msg] = giftRefundWarnings(
      [{ code: 'ABCD-EFGH-JKMN-PQRS', spentTotal: '900.00', currency: 'RUB', status: 'active' }],
      { kind: 'preventive', revealCode: false },
    );
    expect(msg).toBeDefined();
    expect(msg).not.toContain('ABCD');
    expect(msg).toContain('1 шт.');
  });
});
