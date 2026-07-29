import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD: сопоставление позиций корзины с ответом /cart/quote на чекауте.
//
// ДЕФЕКТ №1 (метка «нет в наличии» на ЧУЖОЙ строке). `apiItems` ФИЛЬТРУЕТ позиции
// без productId (старые записи localStorage), сервер нумерует issues[].index по
// этому УРЕЗАННОМУ массиву, а рендер шёл по ПОЛНОМУ items.map((it, idx) =>
// issuesBySku.get(idx)). Индексы расходились ⇒ «нет в наличии» показывалось не у
// той позиции. Правило: индекс ответа сервера сначала переводится в индекс ПОЛНОЙ
// корзины (apiIndexToCartIndex), и только потом ищется в рендере.
//
// ДЕФЕКТ №2 (цены строк из localStorage при серверном итоге). Строка печатала
// fmt(it.price * it.qty) из КОРЗИНЫ, а «Товары»/«Итого» — quote.itemsTotal /
// quote.grandTotal с СЕРВЕРА. При смене цены в каталоге суммы строк не сходились с
// итогом и это ничем не объяснялось. Правило: показываем СЕРВЕРНЫЙ lineTotal
// (quote.lines — источник истины), а расхождение с корзиной объясняем текстом.
//
// Файлы — Next/React-модули; сторожим СУТЬ чтением исходника (как соседние guard-ы).

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');
const form = () => src('app/[lang]/cart/order/CheckoutForm.tsx');

describe('CheckoutForm №1 — issues[].index переводится в индекс ПОЛНОЙ корзины', () => {
  it('есть карта apiIndex → cartIndex (индексы урезанного массива не используются напрямую)', () => {
    const s = form();
    expect(s).toContain('apiIndexToCartIndex');
  });

  it('карта строится из ПОЛНОЙ корзины общим модулем (поведение — в checkout-lines.test)', () => {
    const s = form();
    // Логика перевода индексов вынесена в чистый storefront/lib/checkout-lines,
    // покрытый поведенческими тестами; форма обязана звать именно его, а не
    // заводить рядом собственную (расходящуюся) копию.
    expect(s).toContain("from '@/lib/checkout-lines'");
    expect(s).toMatch(/buildApiIndexToCartIndex\(items\)/);
  });

  it('issuesBySku заполняется ПЕРЕВЕДЁННЫМ индексом, а не iss.index как есть', () => {
    const s = form();
    // Сырой `set(iss.index, ...)` — ровно тот дефект, что чинился.
    expect(s).not.toMatch(/issuesBySku\.set\(\s*iss\.index\s*,/);
    // Раскладка идёт через карту перевода индексов.
    expect(s).toMatch(/mapIssuesToCartIndex\([\s\S]{0,80}apiIndexToCartIndex\)/);
  });

  it('серверные строки тоже раскладываются через карту перевода', () => {
    expect(form()).toMatch(/mapServerLinesToCartIndex\([\s\S]{0,200}apiIndexToCartIndex,?\s*\)/);
  });

  it('нерешаемые позиции названы поимённо, а не одним общим предложением', () => {
    const s = form();
    // t.unresolvableItems сам по себе не называет позиции — рядом обязан быть
    // список их имён.
    expect(s).toContain('unresolvableNames');
    expect(s).toContain('unresolvableItemsList');
  });
});

describe('CheckoutForm №2 — цены строк берутся с СЕРВЕРА (quote.lines)', () => {
  it('quote.lines реально читается (раньше в файле не было ни одного вхождения)', () => {
    expect(form()).toContain('quote.lines');
  });

  it('цена из localStorage — только ФОЛБЭК, серверная сумма приоритетна', () => {
    const code = form()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\{?\s*\/\*[\s\S]*?\*\/\}?$/gm, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Безусловного `fmt(it.price * it.qty)` быть не должно: произведение из корзины
    // допустимо ТОЛЬКО как ветка «серверной строки ещё нет».
    expect(code).not.toMatch(/^\s*\{fmt\(it\.price \* it\.qty\)\}\s*$/m);
    // Тернарник: сначала серверный lineTotal, корзина — во второй ветке.
    expect(code).toMatch(/line \? fmt\(line\.lineTotal\) : fmt\(it\.price \* it\.qty\)/);
  });

  it('серверный lineTotal используется в рендере строки', () => {
    expect(form()).toContain('line.lineTotal');
  });

  it('серверные строки раскладываются по индексу ПОЛНОЙ корзины', () => {
    expect(form()).toContain('serverLinesByCartIndex');
  });

  it('расхождение цены корзины и сервера ОБЪЯСНЯЕТСЯ покупателю', () => {
    const s = form();
    expect(s).toContain('priceChangedNotice');
  });
});

describe('dictionaries — тексты №1/№2 во всех трёх локалях', () => {
  const dict = () => src('lib/dictionaries.ts');

  it('unresolvableItemsList определён (тип + ru/en/fr = минимум 4 вхождения)', () => {
    const s = dict();
    const m = s.match(/unresolvableItemsList/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(4);
  });

  it('priceChangedNotice определён (тип + ru/en/fr = минимум 4 вхождения)', () => {
    const s = dict();
    const m = s.match(/priceChangedNotice/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(4);
  });
});
