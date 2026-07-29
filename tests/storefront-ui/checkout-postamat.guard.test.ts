import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD №5: постамат должен быть ПОМЕЧЕН в списке пунктов выдачи, а флаг
// isPostamat — уезжать в заказ.
//
// ДЕФЕКТ. Витрина звала cdekPvz(city.code) без type и печатала в <option> только
// `{p.address || p.name}` — тип пункта не подписан, хотя DTO его отдаёт (поле
// `type`: PVZ|POSTAMAT). Флаг isPostamat не отправлялся вовсе (grep по storefront/app
// давал ноль), поэтому заказ всегда уходил с isPostamat=false. Постаматы и ПВЗ были
// смешаны в одном списке без метки: покупатель не знал, что выбирает, — а в постамат
// не выдают крупногабарит и там нет примерки.
//
// Правило: у постамата в подписи опции стоит метка из словаря; выбор постамата
// поднимает isPostamat в теле /cart/quote и /orders.

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');
const form = () => src('app/[lang]/cart/order/CheckoutForm.tsx');

describe('CheckoutForm — тип пункта выдачи виден покупателю', () => {
  it('опция ПВЗ подписана типом пункта, а не только адресом', () => {
    const s = form();
    // Голая подпись `{p.address || p.name}` — ровно тот дефект.
    expect(s).not.toMatch(/\{p\.address \|\| p\.name\}\s*<\/option>/);
    expect(s).toContain('pvzOptionLabel');
  });

  it('признак постамата вычисляется из DTO-поля type (регистронезависимо)', () => {
    const s = form();
    expect(s).toContain('isPostamatOffice');
    expect(s).toMatch(/POSTAMAT/i);
  });
});

describe('CheckoutForm — isPostamat уезжает в заказ', () => {
  it('buildDelivery поднимает isPostamat для выбранного пункта', () => {
    // Сравниваем по КОДУ: пояснительные комментарии рядом с флагом иначе
    // раздвигают окно поиска и делают проверку хрупкой.
    const code = form()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('isPostamat');
    // Флаг обязан стоять в ветке type:'pvz' (подвид ПВЗ) — ДО ветки курьера.
    expect(code).toMatch(/type: 'pvz'[\s\S]{0,300}isPostamat[\s\S]{0,400}type: 'courier'/);
    // Значение флага — из типа ВЫБРАННОГО пункта, а не константа.
    expect(code).toContain('isPostamatOffice(selectedPvz)');
  });

  it('пересчёт /cart/quote зависит от выбора пункта (сигнатура включает delivery)', () => {
    // buildDelivery входит в recalcSignature — значит смена пункта (и флага)
    // триггерит пересчёт; проверяем, что зависимость не потерялась.
    expect(form()).toMatch(/recalcSignature[\s\S]{0,400}buildDelivery\(\)/);
  });

  it('buildDelivery знает про выбранный пункт списка (а не только его код)', () => {
    const s = form();
    expect(s).toContain('selectedPvz');
  });
});

describe('dictionaries — метки типа пункта выдачи во всех трёх локалях', () => {
  const dict = () => src('lib/dictionaries.ts');

  it('pvzTypePostamat определён (тип + ru/en/fr = минимум 4 вхождения)', () => {
    const m = dict().match(/pvzTypePostamat/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(4);
  });

  it('pvzTypeOffice определён (тип + ru/en/fr = минимум 4 вхождения)', () => {
    const m = dict().match(/pvzTypeOffice/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(4);
  });

  it('покупателю объяснено ограничение постамата (нет примерки/крупногабарит)', () => {
    const m = dict().match(/pvzPostamatHint/g) ?? [];
    expect(m.length).toBeGreaterThanOrEqual(4);
  });
});
