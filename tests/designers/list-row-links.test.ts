import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DESIGNER_LIST_PATH,
  buildDesignerHref,
} from '../../app/admin/(panel)/catalog/_components/designer-list-url';

// GUARD (навигация из списка «Дизайнеры» в карточку). Тестов React-компонентов в
// проекте нет (vitest environment 'node'), поэтому сторожим исходник чтением — как в
// tests/catalog/tree-view.test.ts и tests/admin/leads-table-layout.test.ts.
//
// ДЕФЕКТ (вторая половина C2): «Отмена» в форме возвращает туда, откуда пришли, только
// если в карточку пришли С параметрами списка. Строки списка вели на голый
// /admin/catalog/designers/${id}, поэтому useSearchParams() в форме был пуст и
// владелец, нашедший дизайнера поиском, после «Отмены» получал список с начала.

const ROOT = resolve(__dirname, '../..');
const listSrc = () =>
  readFileSync(resolve(ROOT, 'app/admin/(panel)/catalog/_components/DesignerList.tsx'), 'utf8');

/**
 * Значения пропа `href={...}` из JSX. Одного уровня вложенности скобок хватает:
 * внутри href может стоять шаблонная строка с `${d.id}`.
 */
const HREF_RE = /href=\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** Имена переменных, которым присвоен результат buildDesignerHref. */
function helperVars(src: string): string[] {
  return [...src.matchAll(/const\s+(\w+)\s*=\s*buildDesignerHref\(/g)].map((m) => m[1]);
}

describe('строки списка дизайнеров уносят состояние списка в карточку', () => {
  it('КАЖДЫЙ href в списке построен через buildDesignerHref (прямо или через переменную)', () => {
    const src = listSrc();
    const derived = helperVars(src);
    const hrefs = [...src.matchAll(HREF_RE)].map((m) => m[1].trim());

    // Имя дизайнера + кнопка «Редактировать» — минимум две ссылки в строке.
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      const viaHelper = href.includes('buildDesignerHref') || derived.includes(href);
      expect(viaHelper, `ссылка в обход хелпера: href={${href}}`).toBe(true);
    }
  });

  it('антипаттерн: голый литерал адреса карточки запрещён', () => {
    const src = listSrc();
    expect(src).not.toMatch(/href=\{\s*`\/admin\/catalog\/designers\/\$\{[^}]+\}`\s*\}/);
    expect(src).not.toMatch(/href="\/admin\/catalog\/designers/);
  });

  it('в хелпер уходит адрес КАРТОЧКИ (с id), а не голый путь списка', () => {
    expect(listSrc()).toMatch(
      /buildDesignerHref\(\s*`\$\{DESIGNER_LIST_PATH\}\/\$\{[^}]+\}`/,
    );
  });

  it('список берёт ЖИВЫЕ параметры из URL (useSearchParams) и передаёт их в хелпер', () => {
    const src = listSrc();
    const queryVar = src.match(/const\s+(\w+)\s*=\s*useSearchParams\(\)\.toString\(\)/)?.[1];
    expect(queryVar, 'query списка не читается через useSearchParams().toString()').toBeTruthy();
    // Вторым аргументом хелпера обязан идти именно он, а не константа/пустая строка.
    expect(src).toMatch(new RegExp(`buildDesignerHref\\([^()]*,\\s*${queryVar}\\s*\\)`));
    // Состояние списка не должно читаться из window напрямую (сломает SSR/гидрацию).
    expect(src).not.toMatch(/window\.location/);
  });

  it('переносится только белый список параметров — вторая реализация правила не заведена', () => {
    const src = listSrc();
    expect(src).toContain("from './designer-list-url'");
    // Ни своего склеивания query, ни своего разбора параметров в компоненте.
    expect(src).not.toMatch(/new URLSearchParams/);
    expect(src).not.toMatch(/parseDesignerListParams/);
  });
});

describe('сценарий владельца: поиск → карточка → «Отмена»', () => {
  it('адрес карточки из отфильтрованного списка несёт search и sort', () => {
    const rowHref = buildDesignerHref(`${DESIGNER_LIST_PATH}/42`, 'search=ann&sort=name_desc');
    expect(rowHref).toBe(`${DESIGNER_LIST_PATH}/42?search=ann&sort=name_desc`);

    // Форма на этой карточке читает тот же query и возвращает владельца в тот же список.
    const backHref = buildDesignerHref(DESIGNER_LIST_PATH, rowHref.split('?')[1]);
    expect(backHref).toBe(`${DESIGNER_LIST_PATH}?search=ann&sort=name_desc`);
  });

  it('мусор из адреса списка в карточку не протаскивается', () => {
    expect(
      buildDesignerHref(`${DESIGNER_LIST_PATH}/42`, 'search=ann&page=3&utm_source=mail&sort=DROP'),
    ).toBe(`${DESIGNER_LIST_PATH}/42?search=ann`);
  });
});
