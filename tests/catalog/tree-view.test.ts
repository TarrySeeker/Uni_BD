import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  childCount,
  expandAll,
  initialExpanded,
  isNodeExpanded,
  parseExpandedState,
  pathTo,
  visibleRows,
} from '@/lib/catalog/tree';
import type { CategoryTreeNode } from '@/lib/catalog/types';

// ЮНИТ: раскрытие/сворачивание дерева категорий в админке (ТЗ владельца п.1 —
// «список меньше, по плюсику открываются подкатегории»). Тестов React-компонентов
// в проекте нет, поэтому вся логика видимости строк живёт в чистых функциях
// lib/catalog/tree.ts, а вёрстку CategoryManager проверяем guard-тестом по исходнику.
//
// Дерево фикстуры:
//   catalog
//   ├─ platki
//   │  └─ bandani
//   └─ twilly
//      └─ twilly-micro
//   certificates (корень-лист)

function node(
  id: string,
  parentId: string | null,
  children: CategoryTreeNode[] = [],
): CategoryTreeNode {
  return {
    id,
    parentId,
    slug: id,
    name: id,
    description: '',
    sort: 0,
    isActive: true,
    imageKey: null,
    seoTitle: null,
    seoDescription: null,
    ogTitle: null,
    ogDescription: null,
    ogImageKey: null,
    canonicalUrl: null,
    noindex: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    children,
  };
}

function fixture(): CategoryTreeNode[] {
  return [
    node('catalog', null, [
      node('platki', 'catalog', [node('bandani', 'platki')]),
      node('twilly', 'catalog', [node('twilly-micro', 'twilly')]),
    ]),
    node('certificates', null),
  ];
}

const ids = (rows: { node: CategoryTreeNode; depth: number }[]) =>
  rows.map((r) => r.node.id);

describe('visibleRows', () => {
  it('со свёрнутым деревом показывает только корни', () => {
    const rows = visibleRows(fixture(), new Set<string>());
    expect(ids(rows)).toEqual(['catalog', 'certificates']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it('раскрывает только детей раскрытых узлов, в порядке обхода', () => {
    const rows = visibleRows(fixture(), new Set(['catalog']));
    expect(ids(rows)).toEqual(['catalog', 'platki', 'twilly', 'certificates']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it('раскрывает вложенный уровень и считает глубину', () => {
    const rows = visibleRows(fixture(), new Set(['catalog', 'twilly']));
    expect(ids(rows)).toEqual([
      'catalog',
      'platki',
      'twilly',
      'twilly-micro',
      'certificates',
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0 + 1, 2, 0]);
  });

  it('не показывает потомков раскрытого узла, если свёрнут его родитель', () => {
    const rows = visibleRows(fixture(), new Set(['platki']));
    expect(ids(rows)).toEqual(['catalog', 'certificates']);
  });

  it('игнорирует id, которых нет в дереве', () => {
    const rows = visibleRows(fixture(), new Set(['нет-такого']));
    expect(ids(rows)).toEqual(['catalog', 'certificates']);
  });
});

describe('expandAll', () => {
  it('возвращает id всех узлов с детьми (листья не нужны)', () => {
    expect([...expandAll(fixture())].sort()).toEqual([
      'catalog',
      'platki',
      'twilly',
    ]);
  });

  it('после раскрытия всего видны все узлы дерева', () => {
    const tree = fixture();
    expect(visibleRows(tree, expandAll(tree))).toHaveLength(6);
  });

  it('на пустом дереве — пустое множество', () => {
    expect(expandAll([]).size).toBe(0);
  });
});

describe('pathTo', () => {
  it('возвращает цепочку от корня до узла включительно', () => {
    expect(pathTo(fixture(), 'twilly-micro')).toEqual([
      'catalog',
      'twilly',
      'twilly-micro',
    ]);
  });

  it('для корня — только он сам', () => {
    expect(pathTo(fixture(), 'catalog')).toEqual(['catalog']);
  });

  it('для неизвестного id — пустой путь', () => {
    expect(pathTo(fixture(), 'нет-такого')).toEqual([]);
  });

  it('раскрытие по пути делает узел видимым', () => {
    const tree = fixture();
    const rows = visibleRows(tree, new Set(pathTo(tree, 'twilly')));
    expect(ids(rows)).toContain('twilly-micro');
  });
});

describe('initialExpanded', () => {
  it('при нескольких корнях не раскрывает ничего', () => {
    expect(initialExpanded(fixture()).size).toBe(0);
  });

  it('при единственном корне раскрывает его — иначе виден один бесполезный узел', () => {
    const single = [fixture()[0]!];
    expect([...initialExpanded(single)]).toEqual(['catalog']);
    expect(visibleRows(single, initialExpanded(single))).toHaveLength(3);
  });

  it('единственный корень-лист раскрывать нечего', () => {
    expect(initialExpanded([node('certificates', null)]).size).toBe(0);
  });

  it('на пустом дереве не падает', () => {
    expect(initialExpanded([]).size).toBe(0);
  });
});

describe('childCount', () => {
  it('считает прямых детей', () => {
    const tree = fixture();
    expect(childCount(tree[0]!)).toBe(2);
    expect(childCount(tree[1]!)).toBe(0);
    expect(childCount(tree[0]!.children[0]!)).toBe(1);
  });
});

// Единый источник правды правила раскрытия: этим предикатом пользуются И
// visibleRows (подпись «Показано N из M»), И рекурсия рендера CategoryManager.
describe('isNodeExpanded', () => {
  it('узел с детьми раскрыт, если его id есть в множестве', () => {
    const tree = fixture();
    expect(isNodeExpanded(tree[0]!, new Set(['catalog']))).toBe(true);
  });

  it('узел с детьми свёрнут, если его id нет в множестве', () => {
    const tree = fixture();
    expect(isNodeExpanded(tree[0]!, new Set<string>())).toBe(false);
    expect(isNodeExpanded(tree[0]!, new Set(['platki']))).toBe(false);
  });

  it('лист не считается раскрытым, даже если его id в множестве', () => {
    const tree = fixture();
    expect(isNodeExpanded(tree[1]!, new Set(['certificates']))).toBe(false);
  });

  it('согласован с visibleRows: дети видны ровно когда предикат истинен', () => {
    const tree = fixture();
    const expanded = new Set(['catalog', 'twilly', 'certificates']);
    const visible = new Set(ids(visibleRows(tree, expanded)));
    const check = (nodes: CategoryTreeNode[]): void => {
      for (const n of nodes) {
        if (!visible.has(n.id)) continue;
        for (const c of n.children) {
          expect(visible.has(c.id)).toBe(isNodeExpanded(n, expanded));
        }
        check(n.children);
      }
    };
    check(tree);
  });
});

describe('parseExpandedState', () => {
  it('разбирает валидный массив строк', () => {
    expect([...parseExpandedState('["catalog","twilly"]')!].sort()).toEqual([
      'catalog',
      'twilly',
    ]);
  });

  it('пустой массив — это осознанное «свернуть всё», а не отсутствие снимка', () => {
    const parsed = parseExpandedState('[]');
    expect(parsed).not.toBeNull();
    expect(parsed!.size).toBe(0);
  });

  it('отфильтровывает элементы не-строки', () => {
    expect([...parseExpandedState('["a",1,null,{"b":2},"c"]')!]).toEqual(['a', 'c']);
  });

  it('невалидный JSON — null', () => {
    expect(parseExpandedState('{не json')).toBeNull();
  });

  it('валидный JSON, но не массив — null', () => {
    expect(parseExpandedState('{"catalog":true}')).toBeNull();
    expect(parseExpandedState('"catalog"')).toBeNull();
    expect(parseExpandedState('42')).toBeNull();
    expect(parseExpandedState('null')).toBeNull();
  });

  it('пустая строка и null — null', () => {
    expect(parseExpandedState('')).toBeNull();
    expect(parseExpandedState(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guard-тест вёрстки: jsdom/@testing-library в проекте нет, поэтому читаем
// исходник компонента и проверяем ключевые инварианты UI (образец —
// tests/storefront-ui/catalog-canonical.test.ts).
// ---------------------------------------------------------------------------

const managerSource = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../app/admin/(panel)/catalog/_components/CategoryManager.tsx',
    ),
    'utf8',
  );

// Подписи UI переведены на next-intl: дефолтный язык (ru) — источник правды
// текста, компонент ссылается на ключи каталога.
const ruMessages = () =>
  readFileSync(resolve(__dirname, '../../messages/ru.json'), 'utf8');

describe('CategoryManager (вёрстка)', () => {
  it('держит состояние раскрытия и берёт логику из lib/catalog/tree', () => {
    const src = managerSource();
    expect(src).toMatch(/from '@\/lib\/catalog\/tree'/);
    expect(src).toMatch(/\bexpandAll\b/);
    expect(src).toMatch(/\bpathTo\b/);
    expect(src).toMatch(/\bvisibleRows\b/);
    expect(src).toMatch(/\bisNodeExpanded\b/);
  });

  it('правило раскрытия — только из lib/catalog/tree, без инлайн-копии в рендере', () => {
    const src = managerSource();
    // рендер спрашивает предикат, а не пересобирает правило руками
    expect(src).toMatch(/const isExpanded = isNodeExpanded\(node, expanded\)/);
    // ни одной собственной проверки множества раскрытых веток в компоненте
    expect(src).not.toMatch(/expanded\.has\(/);
    expect(src).not.toMatch(/children\.length > 0 && /);
  });

  it('рендерит детей условно — по раскрытию, а не всегда', () => {
    const src = managerSource();
    expect(src).toMatch(/\{isExpanded \? \(?\s*<ul/);
    // старый безусловный рендер поддерева не должен остаться
    expect(src).not.toMatch(
      /\{node\.children\.length > 0 \? \(\s*<ul>\{node\.children\.map/,
    );
  });

  it('кнопка раскрытия доступна с клавиатуры и озвучена скринридеру', () => {
    const src = managerSource();
    expect(src).toMatch(/aria-expanded=\{isExpanded\}/);
  });

  it('aria-controls не ссылается на элемент, которого нет в DOM', () => {
    const src = managerSource();
    // id поддерева существует ровно тогда, когда ветка раскрыта
    const idAnchor = /\{isExpanded \? \(?\s*<ul id=\{childrenId\}/;
    expect(src).toMatch(idAnchor);
    // значит и ссылка на него обязана быть условной
    expect(src).not.toMatch(/aria-controls=\{childrenId\}/);
    expect(src).toMatch(
      /aria-controls=\{isExpanded \? childrenId : undefined\}/,
    );
  });

  it('есть тулбар «Развернуть всё / Свернуть всё»', () => {
    const src = managerSource();
    expect(src).toMatch(/catalog\.category\.expandAll/);
    expect(src).toMatch(/catalog\.category\.collapseAll/);
    const ru = ruMessages();
    expect(ru).toContain('Развернуть всё');
    expect(ru).toContain('Свернуть всё');
  });

  it('редкие действия свёрнуты под «Ещё», в строке остаётся «Изменить»', () => {
    const src = managerSource();
    expect(src).toMatch(/catalog\.category\.more/);
    expect(src).toMatch(/menuId === node\.id/);
    expect(src).toMatch(/catalog\.category\.edit/);
    const ru = ruMessages();
    expect(ru).toContain('Ещё');
    expect(ru).toContain('Изменить');
  });

  it('персист раскрытия читается через useSyncExternalStore, а не setState в эффекте', () => {
    const src = managerSource();
    if (!src.includes('localStorage')) return; // персиста может не быть вовсе

    // у внешнего хранилища обязан быть серверный снимок — иначе hydration mismatch
    expect(src).toMatch(/useSyncExternalStore\(\s*\w+,\s*\w+,\s*\w+,?\s*\)/);
    expect(src).toMatch(/function \w+\(\): null \{\s*return null;/);

    // getSnapshot возвращает СТАБИЛЬНЫЙ примитив (сырую строку), иначе
    // useSyncExternalStore уходит в бесконечный ререндер
    expect(src).toMatch(/: string \| null \{[\s\S]{0,200}?localStorage\.getItem\(/);
    expect(src).not.toMatch(/new Set\([^)]*localStorage/);

    // никаких эффектов вокруг раскрытия: ни чтения, ни записи
    expect(src).not.toMatch(/useEffect/);
    expect(src).not.toMatch(/setExpanded\b/);
  });

  it('пользовательские изменения пишутся в хранилище прямо в обработчике', () => {
    const src = managerSource();
    if (!src.includes('localStorage')) return;
    expect(src).toMatch(/localStorage\.setItem\(/);
    // запись живёт в отдельной чистой обёртке, которую зовут toggle/reveal/тулбар
    expect(src).toMatch(/applyExpanded\(/);
    const calls = src.match(/applyExpanded\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
