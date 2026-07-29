import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Аудит №32 (major, ДЕНЬГИ) — валюта показа из БД, валюта заказа из env.
 *
 * ДЕФЕКТ. Показ цен на витрине шёл из ЭФФЕКТИВНЫХ настроек (`lib/config/settings.ts`
 * `code: currency.code ?? env.SHOP_CURRENCY`, т.е. БД приоритетна), а заказ писался
 * из ENV: `lib/orders/repository.ts` `const currency = env.SHOP_CURRENCY` (котировка
 * корзины) и `${env.SHOP_CURRENCY}` прямо в INSERT заказа. Конвертации нет. Итог:
 * владелец меняет базовую валюту в админке — весь сайт показывает новую, а заказ и
 * квитанция уходят в старой ПРИ ТОМ ЖЕ ЧИСЛЕ. Покупатель видит цену в одной валюте,
 * платит в другой.
 *
 * РЕШЕНИЕ (консервативное, БЕЗ тихой конвертации).
 *   1. Единый источник истины: `resolveOrderCurrency(eff, env)` — эффективные
 *      настройки (БД ⊕ env-дефолт), ровно тот же путь, что у показа. Обе точки
 *      (quoteCart и createOrder) обязаны звать его — расхождение показ↔заказ
 *      становится структурно невозможным.
 *   2. Никакого пересчёта сумм: суммы хранятся в базовой валюте магазина, курс
 *      смены базовой валюты платформа не знает и выдумывать его не имеет права.
 *   3. Существующие заказы НЕ трогаются: `orders.currency` — СНИМОК на момент
 *      заказа (ADR-010), в БД он уже записан и остаётся как есть.
 *   4. Валюта нормализуется (trim + верхний регистр): 'rub' в настройках и 'RUB' в
 *      env — одна и та же валюта, и в снимок заказа должен попадать канон.
 */

import { resolveOrderCurrency } from '../../lib/orders/currency';

const REPO_SRC = readFileSync(resolve(__dirname, '../../lib/orders/repository.ts'), 'utf8');

const eff = (code: string | null | undefined) =>
  ({ currency: { code } }) as unknown as Parameters<typeof resolveOrderCurrency>[0];

describe('resolveOrderCurrency — единый источник валюты заказа', () => {
  it('берёт валюту из ЭФФЕКТИВНЫХ настроек (БД приоритетна, как у показа)', () => {
    expect(resolveOrderCurrency(eff('EUR'), { SHOP_CURRENCY: 'RUB' })).toBe('EUR');
  });

  it('env — только фолбэк, когда в настройках валюты нет', () => {
    expect(resolveOrderCurrency(eff(null), { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
    expect(resolveOrderCurrency(eff(undefined), { SHOP_CURRENCY: 'USD' })).toBe('USD');
    expect(resolveOrderCurrency(eff(''), { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
    expect(resolveOrderCurrency(eff('   '), { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
  });

  it('нормализует код к канону ISO-4217 (trim + upper): снимок заказа не «rub»', () => {
    expect(resolveOrderCurrency(eff('rub'), { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
    expect(resolveOrderCurrency(eff(' eur '), { SHOP_CURRENCY: 'RUB' })).toBe('EUR');
    expect(resolveOrderCurrency(eff(null), { SHOP_CURRENCY: ' usd ' })).toBe('USD');
  });

  it('нет ни настроек, ни env — не выдумывает валюту чужого магазина, а падает', () => {
    // Мультитенантность: захардкоженный дефолт ₽ увёл бы чужой магазин не туда.
    expect(() => resolveOrderCurrency(eff(null), { SHOP_CURRENCY: '' })).toThrow();
    expect(() => resolveOrderCurrency(null, { SHOP_CURRENCY: undefined })).toThrow();
  });

  it('устойчив к version skew настроек (нет секции currency / чужой тип)', () => {
    expect(resolveOrderCurrency({} as never, { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
    expect(resolveOrderCurrency({ currency: {} } as never, { SHOP_CURRENCY: 'RUB' })).toBe('RUB');
    expect(resolveOrderCurrency({ currency: { code: 42 } } as never, { SHOP_CURRENCY: 'RUB' })).toBe(
      'RUB',
    );
  });

  it('чистая функция: один и тот же вход — один и тот же выход, без побочек', () => {
    const e = eff('EUR');
    expect(resolveOrderCurrency(e, { SHOP_CURRENCY: 'RUB' })).toBe(
      resolveOrderCurrency(e, { SHOP_CURRENCY: 'RUB' }),
    );
  });
});

describe('GUARD — repository не пишет env.SHOP_CURRENCY в заказ напрямую', () => {
  it('в INSERT заказа больше НЕТ ${env.SHOP_CURRENCY}', () => {
    expect(REPO_SRC).not.toMatch(/\$\{env\.SHOP_CURRENCY\}/);
  });

  it('котировка корзины больше не берёт валюту прямо из env', () => {
    expect(REPO_SRC).not.toMatch(/const\s+currency\s*=\s*env\.SHOP_CURRENCY/);
  });

  it('env.SHOP_CURRENCY в repository не читается вовсе (валюта — только через резолвер)', () => {
    // Комментарии (в них дефект описан по имени) отбрасываем — сторожим КОД.
    const code = REPO_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('env.SHOP_CURRENCY');
  });

  it('обе точки (quote и создание заказа) зовут ОДИН резолвер', () => {
    const calls = REPO_SRC.match(/resolveOrderCurrency\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(REPO_SRC).toContain("from '@/lib/orders/currency'");
  });

  it('тихой конвертации сумм при смене валюты НЕ появилось (пересчёт по курсу запрещён)', () => {
    // Ни курса, ни умножения сумм на rate в пути создания заказа.
    expect(REPO_SRC).not.toMatch(/convertCurrency|exchangeRate|\brate\s*\*/);
  });
});
