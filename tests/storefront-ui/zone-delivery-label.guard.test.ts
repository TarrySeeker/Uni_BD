import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD: нейтральный (мультитенантный) лейбл зональной доставки на чекауте.
//
// ДЕФЕКТ (тех-долг мультитенантности): лейбл MODE-радио зональной доставки был
// зашит по-московски — «Курьер по Москве» (deliveryCourierMoscow), что неверно
// для любого немосковского магазина. Зоны приходят из shop_settings.delivery.zones
// с человекочитаемым label. Правило: лейбл радио — нейтральный ключ
// deliveryCourierZonal, а при ЕДИНСТВЕННОЙ зоне — её конкретный label; сам select
// зон при одной зоне избыточен и скрыт (zones.length > 1).
//
// Файлы — Next/React-модули; сторожим СУТЬ чтением исходника (как соседние guard-ы).

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

describe('dictionaries — московский лейбл убран, нейтральный добавлен во все локали', () => {
  const source = () => src('lib/dictionaries.ts');

  it('нет московского лейбла «Курьер по Москве»', () => {
    expect(source()).not.toContain('Курьер по Москве');
  });

  it('нет ключа deliveryCourierMoscow', () => {
    expect(source()).not.toContain('deliveryCourierMoscow');
  });

  it('deliveryCourierZonal определён в ru/en/fr (тип + 3 локали = минимум 4 вхождения)', () => {
    const s = source();
    expect(s).toContain('deliveryCourierZonal');
    expect(s).toContain('Курьер по региону');
    expect(s).toContain('Zonal courier');
    expect(s).toContain('Coursier par zone');
    const matches = s.match(/deliveryCourierZonal/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

describe('CheckoutForm — зональный лейбл и select управляются числом зон', () => {
  const source = () => src('app/[lang]/cart/order/CheckoutForm.tsx');

  it('не ссылается на t.deliveryCourierMoscow', () => {
    expect(source()).not.toContain('deliveryCourierMoscow');
  });

  it('лейбл радио: при одной зоне — её label, иначе нейтральный deliveryCourierZonal', () => {
    const s = source();
    expect(s).toContain('zones.length === 1 ? zones[0].label : t.deliveryCourierZonal');
  });

  it('select зон гейтится на zones.length > 1 (при одной зоне скрыт)', () => {
    const s = source();
    expect(s).toMatch(/deliveryChoice === 'zone' && zones\.length > 1/);
  });
});
