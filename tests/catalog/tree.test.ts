import { describe, expect, it } from 'vitest';

import {
  canMoveCategory,
  collectAncestors,
  collectDescendants,
  type CategoryEdge,
} from '@/lib/catalog/tree';

// ЮНИТ: защита от циклов в moveCategory — чистая функция, без БД.
//
// Дерево:
//   a
//   ├─ b
//   │  └─ d
//   └─ c
//   e (корень-сирота)
const edges: CategoryEdge[] = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'a' },
  { id: 'd', parentId: 'b' },
  { id: 'e', parentId: null },
];

describe('collectAncestors', () => {
  it('предки d = {b, a}', () => {
    expect([...collectAncestors(edges, 'd')].sort()).toEqual(['a', 'b']);
  });
  it('у корня предков нет', () => {
    expect(collectAncestors(edges, 'a').size).toBe(0);
  });
  it('не зацикливается на повреждённых данных', () => {
    const broken: CategoryEdge[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    // не должно зависнуть
    expect(collectAncestors(broken, 'x').size).toBeLessThanOrEqual(2);
  });
});

describe('collectDescendants', () => {
  it('потомки a = {b, c, d}', () => {
    expect([...collectDescendants(edges, 'a')].sort()).toEqual(['b', 'c', 'd']);
  });
  it('потомки b = {d}', () => {
    expect([...collectDescendants(edges, 'b')]).toEqual(['d']);
  });
  it('у листа потомков нет', () => {
    expect(collectDescendants(edges, 'd').size).toBe(0);
  });
});

describe('canMoveCategory — запрет циклов', () => {
  it('перенос в корень всегда можно', () => {
    expect(canMoveCategory(edges, 'b', null)).toBe(true);
  });
  it('нельзя стать собственным родителем', () => {
    expect(canMoveCategory(edges, 'b', 'b')).toBe(false);
  });
  it('нельзя переместить узел под своего потомка (a → под d)', () => {
    expect(canMoveCategory(edges, 'a', 'd')).toBe(false);
    expect(canMoveCategory(edges, 'a', 'b')).toBe(false);
  });
  it('можно переместить под чужую ветку (d → под c)', () => {
    expect(canMoveCategory(edges, 'd', 'c')).toBe(true);
    expect(canMoveCategory(edges, 'b', 'e')).toBe(true);
  });
});
