import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты moveCategory — целевая проверка MAJOR-бага #6 (TOCTOU при
 * перемещении категорий). lib/catalog/actions.ts. БЕЗ БД/Next/S3.
 *
 * КОРЕНЬ БАГА: handler читал дерево рёбер (listCategoryEdges → обычный SELECT
 * БЕЗ блокировки и БЕЗ транзакции), проверял цикл чистой canMoveCategory, затем
 * ОТДЕЛЬНЫМ UPDATE писал результат. Между чтением и записью — окно TOCTOU: два
 * параллельных moveCategory ({A→B} и {B→A}) читают одинаковое ДО-состояние, оба
 * проходят проверку, оба коммитят → цикл A↔B (БД-CHECK categories_no_self_parent
 * ловит только A→A, не многоузловые циклы). Узлы становятся неудаляемыми.
 *
 * ФИКС: «прочитать рёбра → проверить цикл → обновить» — в ОДНОЙ транзакции
 * sql.begin, в начале которой берётся сериализующая advisory-xact-блокировка на
 * всё дерево (pg_advisory_xact_lock(hashtext('categories_tree'))). Любые
 * конкурентные перемещения сериализуются — окно TOCTOU закрыто.
 *
 * Регресс-цель: эти тесты ПАДАЛИ БЫ на старом коде (он не вызывал sql.begin и не
 * брал advisory-lock; рёбра читались отдельным запросом ВНЕ транзакции).
 *
 * Мок: sql — tagged-template-спай; sql.begin(cb) → cb(sqlMock), tx — тот же спай
 * (записи попадают в sqlCalls). Ответы подбираются по подстроке шаблона.
 */

const H = vi.hoisted(() => {
  interface SqlCall {
    text: string;
    strings: string[];
    args: unknown[];
  }
  interface QueuedResult {
    match: string;
    rows?: unknown[];
    times?: number;
  }
  const state = {
    currentUser: null as AuthUser | null,
    sqlCalls: [] as SqlCall[],
    sqlResponses: [] as QueuedResult[],
    beginCalls: 0,
  };

  function templateText(strings: TemplateStringsArray | string[]): string {
    return Array.from(strings).join('?');
  }

  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = templateText(strings);
    state.sqlCalls.push({ text, strings: Array.from(strings), args });
    for (const r of state.sqlResponses) {
      if (text.includes(r.match)) {
        if (typeof r.times === 'number') {
          if (r.times <= 0) continue;
          r.times -= 1;
        }
        return Promise.resolve(r.rows ?? []);
      }
    }
    return Promise.resolve([] as unknown[]);
  });
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  // sql.begin: tx — тот же спай (записи в sqlCalls). Если коллбэк бросает —
  // begin реджектит, имитируя ROLLBACK (как реальный postgres.js).
  (sqlMock as unknown as { begin: unknown }).begin = async (
    cb: (tx: unknown) => unknown,
  ) => {
    state.beginCalls += 1;
    return cb(sqlMock);
  };

  return {
    state,
    sqlMock,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
  };
});

const { sqlMock } = H;

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('@/lib/config/settings', () => ({ isModuleEffectivelyEnabled: async () => true }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));

// Импорт actions ПОСЛЕ моков.
import { moveCategory } from '@/lib/catalog/actions';

function makeOwner(): AuthUser {
  return {
    id: 'u-1',
    email: 'owner@shop.io',
    isOwner: true,
    permissions: new Set<PermissionCode>(),
  };
}

// Валидные UUID (uuidSchema требует формат UUID).
const CAT_A = '11111111-1111-4111-8111-111111111111';
const CAT_B = '22222222-2222-4222-8222-222222222222';
const CAT_C = '33333333-3333-4333-8333-333333333333';

/** Находит первый sql-вызов, чей шаблон содержит подстроку. */
function findCall(match: string) {
  return H.state.sqlCalls.find((c) => c.text.includes(match));
}
/** Все sql-вызовы, чей шаблон содержит подстроку. */
function findCalls(match: string) {
  return H.state.sqlCalls.filter((c) => c.text.includes(match));
}
/** Индекс первого sql-вызова, чей шаблон содержит подстроку (или -1). */
function indexOfCall(match: string): number {
  return H.state.sqlCalls.findIndex((c) => c.text.includes(match));
}

/** Засеять ответ SELECT рёбер (читается ВНУТРИ транзакции после advisory-lock). */
function seedEdges(rows: { id: string; parent_id: string | null }[]): void {
  H.state.sqlResponses.push({
    match: 'FROM categories',
    rows,
  });
}

beforeEach(() => {
  H.state.currentUser = makeOwner();
  H.state.sqlCalls = [];
  H.state.sqlResponses = [];
  H.state.beginCalls = 0;
  sqlMock.mockClear();
  H.writeAuditSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// БАГ #6 — moveCategory: чтение рёбер + проверка цикла + запись в ОДНОЙ
// транзакции с сериализующей advisory-блокировкой (закрытие окна TOCTOU).
// =============================================================================

describe('БАГ #6 — moveCategory сериализует перемещения (TOCTOU)', () => {
  it('#6: вся операция выполняется в ОДНОЙ транзакции (sql.begin вызвана ровно один раз)', async () => {
    // Дерево: A — корень, B — ребёнок A. Переносим B под корень (sort).
    seedEdges([
      { id: CAT_A, parent_id: null },
      { id: CAT_B, parent_id: CAT_A },
    ]);
    // UPDATE возвращает строку (категория существует).
    H.state.sqlResponses.push({
      match: 'UPDATE categories',
      rows: [{ id: CAT_B, parent_id: null, sort: 0 }],
    });

    const res = await moveCategory({ id: CAT_B, parentId: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // На старом коде sql.begin НЕ вызывалась вовсе → этот assert падал.
    expect(H.state.beginCalls).toBe(1);
  });

  it('#6: перед чтением рёбер берётся advisory-xact-lock на дерево категорий', async () => {
    seedEdges([
      { id: CAT_A, parent_id: null },
      { id: CAT_B, parent_id: CAT_A },
    ]);
    H.state.sqlResponses.push({
      match: 'UPDATE categories',
      rows: [{ id: CAT_B, parent_id: null, sort: 0 }],
    });

    await moveCategory({ id: CAT_B, parentId: null });

    // Должен быть запрос advisory-блокировки (сериализация перемещений).
    const lock = findCall('pg_advisory_xact_lock');
    expect(lock, 'отсутствует pg_advisory_xact_lock — окно TOCTOU открыто').toBeDefined();

    // Блокировка должна идти ДО чтения рёбер (SELECT ... FROM categories) и ДО UPDATE.
    const lockIdx = indexOfCall('pg_advisory_xact_lock');
    const selectIdx = indexOfCall('SELECT id, parent_id');
    const updateIdx = indexOfCall('UPDATE categories');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(lockIdx);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });

  it('#6: попытка создать цикл (новый родитель — потомок узла) → CatalogError(cycle), UPDATE НЕ выполняется', async () => {
    // Дерево: A — корень, B — ребёнок A. Пытаемся сделать A ребёнком B → цикл.
    seedEdges([
      { id: CAT_A, parent_id: null },
      { id: CAT_B, parent_id: CAT_A },
    ]);

    const res = await moveCategory({ id: CAT_A, parentId: CAT_B });
    // CatalogError наследует PublicActionError → пайплайн маппит в 'validation'
    // + понятный message (доходит до UI).
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('validation');
      expect(res.message).toContain('поддерева');
    }
    // КЛЮЧЕВОЕ: при цикле запись не должна произойти.
    expect(findCalls('UPDATE categories')).toHaveLength(0);
    // И операция всё равно шла внутри транзакции с advisory-lock.
    expect(H.state.beginCalls).toBe(1);
    expect(findCall('pg_advisory_xact_lock')).toBeDefined();
  });

  it('#6: успешное перемещение (нет цикла) → UPDATE выполнен, результат { id }', async () => {
    // Дерево: A, B, C — все корни. Переносим C под A.
    seedEdges([
      { id: CAT_A, parent_id: null },
      { id: CAT_B, parent_id: null },
      { id: CAT_C, parent_id: null },
    ]);
    H.state.sqlResponses.push({
      match: 'UPDATE categories',
      rows: [{ id: CAT_C, parent_id: CAT_A, sort: 5 }],
    });

    const res = await moveCategory({ id: CAT_C, parentId: CAT_A, sort: 5 });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ id: CAT_C });
    }
    const updates = findCalls('UPDATE categories');
    expect(updates).toHaveLength(1);
    // UPDATE интерполирует нового родителя и id узла.
    expect(updates[0]!.args).toContain(CAT_A);
    expect(updates[0]!.args).toContain(CAT_C);
    // Аудит перемещения записан.
    expect(H.writeAuditSpy).toHaveBeenCalledTimes(1);
  });

  it('#6: категория не найдена (UPDATE вернул пусто) → CatalogError(not_found), без аудита', async () => {
    seedEdges([{ id: CAT_A, parent_id: null }]);
    // UPDATE возвращает пустой массив → not_found.
    H.state.sqlResponses.push({ match: 'UPDATE categories', rows: [] });

    const res = await moveCategory({ id: CAT_B, parentId: CAT_A });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('validation');
      expect(res.message).toContain('не найдена');
    }
    // not_found — аудит не пишется (исключение до возврата).
    expect(H.writeAuditSpy).not.toHaveBeenCalled();
  });
});
