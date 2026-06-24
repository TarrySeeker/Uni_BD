/**
 * Чистая логика дерева категорий (docs/05 §4.3 «защита от циклов»).
 *
 * Выделено отдельно от Server Action, чтобы проверка цикла тестировалась
 * юнитом без БД. moveCategory передаёт сюда плоский список рёбер (id→parentId),
 * прочитанный из БД, и спрашивает: можно ли назначить узлу нового родителя.
 */

/** Ребро дерева: узел и его текущий родитель (null для корня). */
export interface CategoryEdge {
  id: string;
  parentId: string | null;
}

/**
 * Собирает множество id всех предков узла `nodeId` (по цепочке parentId).
 * Защищён от зацикленных данных (на случай уже повреждённого дерева).
 */
export function collectAncestors(
  edges: CategoryEdge[],
  nodeId: string,
): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const e of edges) {
    parentOf.set(e.id, e.parentId);
  }

  const ancestors = new Set<string>();
  let current = parentOf.get(nodeId) ?? null;
  while (current && !ancestors.has(current)) {
    ancestors.add(current);
    current = parentOf.get(current) ?? null;
  }
  return ancestors;
}

/**
 * Собирает множество id всех потомков узла `nodeId` (поддерево, не включая сам узел).
 */
export function collectDescendants(
  edges: CategoryEdge[],
  nodeId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.parentId) {
      const list = childrenOf.get(e.parentId) ?? [];
      list.push(e.id);
      childrenOf.set(e.parentId, list);
    }
  }

  const descendants = new Set<string>();
  const stack = [...(childrenOf.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (descendants.has(id)) {
      continue;
    }
    descendants.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      stack.push(child);
    }
  }
  return descendants;
}

/**
 * Можно ли переместить узел `nodeId` под нового родителя `newParentId`,
 * не создавая цикла.
 *
 * Цикл возникает, если новый родитель — это сам узел ИЛИ любой его потомок.
 * Перенос в корень (newParentId = null) всегда допустим.
 *
 * @returns true — перемещение безопасно; false — приведёт к циклу.
 */
export function canMoveCategory(
  edges: CategoryEdge[],
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) {
    return true;
  }
  if (newParentId === nodeId) {
    return false;
  }
  const descendants = collectDescendants(edges, nodeId);
  return !descendants.has(newParentId);
}
