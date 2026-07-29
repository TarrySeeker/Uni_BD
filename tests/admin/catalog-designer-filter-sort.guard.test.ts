import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyDesignerSort } from '@/lib/designers/sort';

/**
 * GUARD: выпадающий фильтр «Дизайнер» в каталоге админки отсортирован по алфавиту.
 *
 * Запрос заказчика (2026-07-29): в разделе «Дизайнеры» алфавитный порядок уже есть и
 * удобен, а в фильтре каталога дизайнеры шли вперемешку — искать в списке из 17 имён
 * приходилось глазами.
 *
 * ПРИЧИНА была не в компоненте, а в вызове: `listDesigners()` по умолчанию отдаёт
 * `ORDER BY sort, name` — то есть по РУЧНОМУ порядку (колонка `sort`), который владелец
 * задаёт для витрины. Для витрины это правильно (там порядок — оформительское решение),
 * а для служебного фильтра нужен предсказуемый алфавит.
 *
 * Сторожим ПРИЧИНУ: страница каталога обязана запрашивать дизайнеров с явной
 * сортировкой по имени. Вёрстку не трогаем — тестов React-компонентов в проекте нет
 * (environment: 'node'), поэтому проводку проверяем по исходнику, как в
 * operator-screens.guard.test.ts.
 */
describe('GUARD: фильтр дизайнеров в каталоге — алфавит', () => {
  const catalogPage = readFileSync(
    join(process.cwd(), 'app/admin/(panel)/catalog/page.tsx'),
    'utf8',
  );

  it('страница каталога запрашивает дизайнеров с сортировкой по имени', () => {
    // Именно вызов, а не просто присутствие строки где-то в файле.
    expect(catalogPage).toMatch(/listDesigners\(\s*\{[^}]*sort:\s*'name_asc'/s);
  });

  it('вызов без сортировки (прежнее поведение) в файле не остался', () => {
    expect(catalogPage).not.toMatch(/listDesigners\(\s*\)/);
  });

  // Тот же список дизайнеров выбирают в форме товара — заказчик упрётся в него сразу,
  // как начнёт править карточки. Чиним и сторожим все экраны разом, а не только фильтр.
  it.each([
    ['app/admin/(panel)/catalog/products/[id]/page.tsx', 'редактирование товара'],
    ['app/admin/(panel)/catalog/products/new/page.tsx', 'создание товара'],
  ])('%s (%s) — тоже запрашивает дизайнеров по алфавиту', (path) => {
    const src = readFileSync(join(process.cwd(), path), 'utf8');
    expect(src).toMatch(/listDesigners\(\s*\{[^}]*sort:\s*'name_asc'/s);
    expect(src).not.toMatch(/listDesigners\(\s*\)/);
  });

  /**
   * ЖИВАЯ НАХОДКА 2026-07-29: сортировка запрашивалась БЕЗ локали, а раздел
   * «Дизайнеры» — с ней (`locale: defaultLocale`). Пустая локаль даёт
   * `new Intl.Collator(undefined)` → системная локаль контейнера, а она `en-US`
   * при базовом языке магазина `ru`. Порядок расходится:
   *   ru: ангел | Егоров | Ёлка | Яна | ART
   *   en: ART | ангел | Егоров | Ёлка | Яна
   * Сейчас не проявляется — все 17 дизайнеров с латинскими именами. Выстрелит
   * на первом кириллическом: фильтр и раздел покажут РАЗНЫЙ алфавит.
   */
  it.each([
    ['app/admin/(panel)/catalog/page.tsx', 'фильтр каталога'],
    ['app/admin/(panel)/catalog/products/[id]/page.tsx', 'редактирование товара'],
    ['app/admin/(panel)/catalog/products/new/page.tsx', 'создание товара'],
  ])('%s (%s) — сортирует в локали магазина, а не в системной', (path) => {
    const src = readFileSync(join(process.cwd(), path), 'utf8');
    const call = src.slice(src.indexOf('listDesigners('));
    expect(call.slice(0, 200)).toMatch(/locale:/);
  });

  it('движок сортировки действительно упорядочивает по алфавиту', () => {
    // Реальные имена дизайнеров магазина: латиница, разный регистр, диакритика.
    const list = [
      { name: 'PHILIPPE JORDAN' },
      { name: 'Elenanika' },
      { name: 'ICÔNE GALERIE' },
      { name: 'ART NA STOLE' },
      { name: 'Jean-Sébastien Génot' },
    ];

    const sorted = applyDesignerSort(list, 'name_asc', 'ru').map((d) => d.name);

    expect(sorted).toEqual([
      'ART NA STOLE',
      'Elenanika',
      'ICÔNE GALERIE',
      'Jean-Sébastien Génot',
      'PHILIPPE JORDAN',
    ]);
  });

  it('регистр не влияет на порядок: KOKOSHA идёт после Kaleidoscop', () => {
    const sorted = applyDesignerSort(
      [{ name: 'KOKOSHA STUDIO' }, { name: 'Kaleidoscop' }],
      'name_asc',
      'ru',
    ).map((d) => d.name);

    expect(sorted).toEqual(['Kaleidoscop', 'KOKOSHA STUDIO']);
  });
});
