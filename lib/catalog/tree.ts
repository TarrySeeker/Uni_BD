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

// -----------------------------------------------------------------------------
// Раскрытие/сворачивание дерева в UI (ТЗ владельца п.1).
//
// Компонент дерева — клиентский, а тестов React-компонентов в проекте нет, поэтому
// вся логика видимости строк вынесена сюда чистыми функциями и покрыта юнитами
// (tests/catalog/tree-view.test.ts). Функции обобщённые: работают с любым узлом,
// у которого есть id и children, — CategoryTreeNode, узел меню, дерево витрины.
// -----------------------------------------------------------------------------

/** Минимальная форма узла дерева: идентификатор + дети того же типа. */
export interface TreeNodeLike<T> {
  id: string;
  children: T[];
}

/** Видимая строка дерева: сам узел и его глубина вложенности (0 — корень). */
export interface VisibleRow<T> {
  node: T;
  depth: number;
}

/**
 * Раскрыт ли узел — ЕДИНСТВЕННЫЙ источник правды этого правила.
 *
 * Им пользуются и visibleRows (подпись «Показано N из M»), и рекурсия рендера
 * CategoryManager: иначе рендер повторял бы правило инлайном и юниты сторожили
 * бы функцию, от которой картинка на экране не зависит.
 */
export function isNodeExpanded<T extends TreeNodeLike<T>>(
  node: T,
  expanded: ReadonlySet<string>,
): boolean {
  return node.children.length > 0 && expanded.has(node.id);
}

/**
 * Разбор сохранённого снимка раскрытых веток (сырая строка из localStorage).
 *
 * @returns множество id; null — снимка нет или он повреждён (тогда работает
 * раскрытие по умолчанию). Пустой массив — это осознанное «свернуть всё»,
 * а не отсутствие снимка, поэтому он даёт пустое множество, а не null.
 */
export function parseExpandedState(
  raw: string | null | undefined,
): Set<string> | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return new Set(parsed.filter((v): v is string => typeof v === 'string'));
}

/**
 * Плоский список ВИДИМЫХ строк в порядке обхода сверху вниз.
 *
 * Корни видны всегда; дети узла — только если его id есть в `expanded`. Узел,
 * раскрытый сам, но лежащий под свёрнутым родителем, остаётся скрытым.
 */
export function visibleRows<T extends TreeNodeLike<T>>(
  nodes: readonly T[],
  expanded: ReadonlySet<string>,
): VisibleRow<T>[] {
  const rows: VisibleRow<T>[] = [];
  const walk = (list: readonly T[], depth: number): void => {
    for (const node of list) {
      rows.push({ node, depth });
      if (isNodeExpanded(node, expanded)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

/** Множество id всех узлов, у которых есть дети («развернуть всё»). */
export function expandAll<T extends TreeNodeLike<T>>(
  nodes: readonly T[],
): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly T[]): void => {
    for (const node of list) {
      if (node.children.length > 0) {
        ids.add(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Цепочка id от корня до узла `id` включительно; пустой массив — узла нет.
 *
 * Нужна для авто-раскрытия: после создания или перемещения категории её родителя
 * и всех его предков надо раскрыть, иначе категория «исчезнет» под свёрнутой
 * веткой и владелец решит, что она пропала.
 */
export function pathTo<T extends TreeNodeLike<T>>(
  nodes: readonly T[],
  id: string,
): string[] {
  const walk = (list: readonly T[], trail: string[]): string[] | null => {
    for (const node of list) {
      const next = [...trail, node.id];
      if (node.id === id) {
        return next;
      }
      const found = walk(node.children, next);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(nodes, []) ?? [];
}

/**
 * Раскрытие по умолчанию: дерево свёрнуто до корневых категорий.
 *
 * Исключение — единственный корень (частый случай: один корень «Каталог»):
 * свёрнутое дерево показало бы ровно одну бесполезную строку, поэтому такой
 * корень раскрываем.
 */
export function initialExpanded<T extends TreeNodeLike<T>>(
  nodes: readonly T[],
): Set<string> {
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only && only.children.length > 0) {
    return new Set([only.id]);
  }
  return new Set<string>();
}

/** Количество прямых подкатегорий узла. */
export function childCount<T extends TreeNodeLike<T>>(node: T): number {
  return node.children.length;
}
