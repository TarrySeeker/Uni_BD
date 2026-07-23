import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD (вёрстка): «Не крутятся Заявки в сторону» — п.8 ТЗ владельца.
//
// Тестов React-компонентов в проекте нет (vitest environment 'node', ни jsdom, ни
// @testing-library), поэтому вёрстку сторожим чтением исходников — как это уже
// сделано для витрины (tests/storefront-ui/catalog-canonical.test.ts).
//
// Формулировка владельца неточна: обёртка `overflow-x-auto` у таблицы стояла и до
// правки. Реальных причин, по которым горизонтальный скролл не работал, три, и они
// складываются:
//   1) <main> каркаса админки — flex-элемент БЕЗ min-w-0. У flex-элемента
//      min-width:auto, т.е. он не может стать уже своего min-content: широкая
//      таблица распирала всю страницу вместо того, чтобы включить скролл ВНУТРИ
//      обёртки. Дефект каркаса, а не раздела.
//   2) секция «Заявок» ограничена max-w-5xl (1024px) при девяти колонках;
//   3) <table class="w-full"> при auto table-layout схлопывается до min-content
//      обёртки и не вылезает за неё — нужна явная арифметическая минимальная
//      ширина (min-w-[72rem]). min-w-full тут бесполезен: это min-width:100%.
//   4) LIST_LIMIT=200 строк с инлайновой textarea в каждой делали обёртку высотой
//      в десятки тысяч px, и горизонтальный скроллбар (он снизу обёртки) физически
//      оказывался вне экрана. Отсюда ограничение высоты + липкая шапка.
//
// Пункты 1 и 2 обязаны меняться ВМЕСТЕ: снять max-w-5xl без min-w-0 — значит
// увести вбок всю страницу вместе с Sidebar и Topbar.

const ROOT = resolve(__dirname, '../..');
const source = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const layoutSrc = () => source('app/admin/(panel)/layout.tsx');
const leadsSrc = () => source('app/admin/(panel)/leads/page.tsx');

/** className первого тега `tag` в исходнике. */
function tagClass(src: string, tag: string): string {
  const m = src.match(new RegExp(`<${tag}\\b[^>]*className="([^"]*)"`));
  expect(m, `в исходнике не найден <${tag} className="...">`).not.toBeNull();
  return m![1];
}

/** Значение строковой константы `name` в исходнике (const NAME = '...'). */
function constValue(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name} =\\s*'([^']*)'`));
  expect(m, `в исходнике не найдена константа ${name}`).not.toBeNull();
  return m![1];
}

/** Все значения className в исходнике (комментарии сюда не попадают). */
function allClasses(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * className элемента, непосредственно оборачивающего `marker`.
 *
 * Ограничитель ширины намеренно проверяется НЕ на <td>: по CSS 2.1 действие
 * max-width на ячейку таблицы не определено, Chrome и Firefox его при
 * table-layout:auto игнорируют. Работает только блочный элемент ВНУТРИ ячейки.
 */
function wrapperClassOf(src: string, marker: string): string {
  const m = src.match(new RegExp(`className="([^"]*)"[^>]*>\\s*\\{?\\s*${marker}`));
  expect(m, `не найдена обёртка с содержимым ${marker}`).not.toBeNull();
  return m![1];
}

describe('каркас админки: <main> умеет сжиматься (min-w-0)', () => {
  it('<main> помечен min-w-0 — иначе широкая таблица распирает страницу', () => {
    expect(tagClass(layoutSrc(), 'main')).toMatch(/\bmin-w-0\b/);
  });

  it('<main> остаётся растягивающимся flex-элементом с внутренними отступами', () => {
    const cls = tagClass(layoutSrc(), 'main');
    expect(cls).toMatch(/\bflex-1\b/);
    expect(cls).toMatch(/\bp-4\b/);
  });
});

describe('раздел «Заявки»: таблица прокручивается вбок', () => {
  it('секция раздела не зажата в max-w-5xl', () => {
    expect(leadsSrc()).not.toMatch(/max-w-5xl/);
  });

  it('обёртка таблицы включает горизонтальный скролл', () => {
    expect(leadsSrc()).toMatch(/overflow-x-auto/);
  });

  it('у <table> есть явная минимальная ширина, и это НЕ min-w-full', () => {
    const cls = tagClass(leadsSrc(), 'table');
    // min-w-full === min-width:100% — скролла не даёт, ловим отдельно.
    expect(cls).not.toMatch(/\bmin-w-full\b/);
    expect(cls).toMatch(/\bmin-w-\[[^\]]+\]/);
  });

  it('высота обёртки ограничена — иначе скроллбар уезжает под экран', () => {
    // 200 строк с textarea в каждой = обёртка в десятки тысяч px.
    expect(leadsSrc()).toMatch(/max-h-\[[^\]]+\]/);
    expect(leadsSrc()).toMatch(/overflow-y-auto/);
  });

  it('шапка таблицы липкая — при вертикальном скролле колонки не теряются', () => {
    expect(leadsSrc()).toMatch(/sticky top-0/);
  });

  it('раздел не чинит себя сам: min-w-0 живёт только на <main> каркаса', () => {
    // Корневой <div> раздела — обычный блочный потомок <main> (у <main> нет
    // display:flex), значит min-width у него и так 0. Класс min-w-0 здесь ничего
    // не делает, но создаёт иллюзию, что раздел не зависит от каркаса.
    expect(tagClass(layoutSrc(), 'main')).not.toMatch(/\bflex\b(?!-)/);
    for (const cls of allClasses(leadsSrc())) {
      expect(cls, `min-w-0 в разметке раздела: "${cls}"`).not.toMatch(/\bmin-w-0\b/);
    }
  });
});

describe('раздел «Заявки»: липкая шапка не теряет нижнюю линию', () => {
  it('линия шапки рисуется тенью, а не border — border-collapse её не сохраняет', () => {
    // Tailwind preflight ставит таблицам border-collapse:collapse. При схлопнутых
    // границах бордюр рисует таблица, а не ячейка, и он НЕ едет вместе со sticky-
    // элементом (Chrome/Firefox): при прокрутке линия пропадает, строки наезжают.
    const th = constValue(leadsSrc(), 'TH');
    expect(th).toMatch(/\bsticky top-0\b/);
    expect(th).not.toMatch(/\bborder-b\b/);
    expect(th).toMatch(/\bshadow-\[inset_0_-1px_0_[^\]]+\]/);
  });

  it('шапка остаётся непрозрачной — иначе строки просвечивают сквозь неё', () => {
    const th = constValue(leadsSrc(), 'TH');
    expect(th).toMatch(/\bbg-white\b/);
    expect(th).toMatch(/\bz-10\b/);
  });

  it('таблица не переведена на border-separate ради обхода проблемы', () => {
    // border-separate дал бы работающий border на ячейке, но разъехал бы рамки
    // строк — фиксируем выбранное решение явно.
    expect(leadsSrc()).not.toMatch(/border-separate/);
  });
});

describe('раздел «Заявки»: длинный текст не растягивает строку бесконечно', () => {
  it('колонка «Сообщение» ограничена по ширине и переносит длинные слова', () => {
    const cls = wrapperClassOf(leadsSrc(), 'l\\.message');
    expect(cls).toMatch(/\bmax-w-\[[^\]]+\]/);
    expect(cls).toMatch(/\bbreak-words\b/);
  });

  it('колонка «Ответ оператора» имеет заданную ширину', () => {
    expect(wrapperClassOf(leadsSrc(), '<LeadAnswerForm')).toMatch(
      /\b(?:max-w|w)-\[[^\]]+\]/,
    );
  });
});
