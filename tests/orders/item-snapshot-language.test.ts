import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { certificateItemHint } from '@/lib/gift-certificates/origin';

/**
 * Аудит minor №10: в снимок позиции заказа (order_items.name_snapshot) пишется
 * БАЗОВОЕ (русское) название товара, поэтому позиция «меняет язык» между
 * чекаутом (локализованный каталог) и подтверждением заказа.
 *
 * 🔴 РЕШЕНИЕ: ХРАНЕНИЕ НЕ МЕНЯЕМ — фиксируем как ОСОЗНАННЫЙ ИНВАРИАНТ.
 *
 * Снимок заказа — юридически значимый документ, и он же питает необратимые
 * денежные и правовые процессы, которые про локаль покупателя ничего не знают:
 *   • ФИСКАЛЬНЫЙ ЧЕК 54-ФЗ (lib/payments/tbank/receipt.ts, paykeeper/service.ts)
 *     — наименование в чеке ОФД; для РФ-магазина оно обязано быть стабильным и
 *     русским, а не зависеть от того, с какого URL-префикса покупатель оформил;
 *   • НАКЛАДНАЯ СДЭК (lib/cdek/services/order.ts) — состав вложения;
 *   • АВТОВЫПУСК СЕРТИФИКАТОВ (lib/gift-certificates/origin.ts) — распознаёт
 *     позицию-сертификат по подстроке в name_snapshot.
 * Локализация хранимого снимка сделала бы эти процессы зависимыми от языка сессии
 * покупателя: чек на французском, несработавший автовыпуск, «поехавшая» история
 * заказов при смене языка магазина. Риск несопоставим с косметической выгодой.
 *
 * Локализовать здесь следует ОТОБРАЖЕНИЕ (витрина показывает покупателю
 * локализованный каталог до оформления), а не запись. Этот тест не даёт молча
 * развернуть решение обратно.
 */

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('🔴 снимок позиции заказа НЕ локализуется (осознанный инвариант, minor №10)', () => {
  it('resolveCartLine строит name из базовых полей каталога, без LocalizeCtx', () => {
    const src = read('lib/orders/repository.ts');
    const fn = src.slice(src.indexOf('export async function resolveCartLine'));
    const body = fn.slice(0, fn.indexOf('\nexport '));

    // Имя позиции — из базовых product.name/variant.name.
    expect(body).toMatch(/name:\s*variant\s*\?\s*`\$\{product\.name\}/);
    // И НЕ через слой локализации: снимок обязан быть языконезависимым.
    expect(body, 'снимок начали локализовать — см. шапку теста').not.toMatch(
      /localizeRow|localizeField|LocalizeCtx/,
    );
  });

  it('автовыпуск сертификата распознаёт позицию по русской подстроке', () => {
    // Прямое следствие инварианта: локализованный снимок сломал бы распознавание.
    expect(certificateItemHint({
      nameSnapshot: 'Подарочный сертификат 5000',
      attributesSnapshot: {},
    } as Parameters<typeof certificateItemHint>[0])).toBe('name');
  });

  it('фискальный чек берёт наименование прямо из снимка (54-ФЗ)', () => {
    const src = read('lib/payments/tbank/receipt.ts');
    expect(src).toMatch(/Name:\s*it\.nameSnapshot/);
  });
});
