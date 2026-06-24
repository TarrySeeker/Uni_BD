import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * ЮНИТ-тесты Server Actions каталога — целевая проверка четырёх багов
 * (#10/#11/#13/#14) lib/catalog/actions.ts. БЕЗ БД/Next/S3.
 *
 * actions.ts ходит в БД через tagged-template `sql` (НЕ sql.begin), а также
 * вызывает rebuildProductAttributesCache, getStorage, validateUpload,
 * generatePreviews. Все эти зависимости изолированы vi.mock-ами:
 *   • @/lib/db/client.sql       → tagged-template-спай: пишет {strings,args}
 *                                  каждого вызова в state.sqlCalls и снимает
 *                                  результат из управляемой очереди по матчеру;
 *   • @/lib/catalog/cache       → rebuildProductAttributesCache (no-op {});
 *   • @/lib/storage             → getStorage().put/.delete (mock);
 *   • @/lib/storage/validate    → validateUpload (ok);
 *   • @/lib/storage/image       → generatePreviews (фиктивный main);
 *   • @/lib/config/settings     → isModuleEffectivelyEnabled → true;
 *   • @/lib/auth/session        → getCurrentUser (owner, проходит guard);
 *   • next/cache, next/headers, @/lib/audit/log → no-op/спай.
 *
 * Для #10/#11 утверждаем формируемые SQL (склейку статических кусков и
 * интерполированные аргументы). Для #13/#14 — порядок запросов и бросание
 * CatalogError (наследует PublicActionError → пайплайн defineAction маппит в
 * error:'validation' + человекочитаемый message, который доходит до UI).
 */

// --- управляемое состояние моков ---------------------------------------------

const H = vi.hoisted(() => {
  interface SqlCall {
    /** Статические куски шаблона (`strings`), склеенные через '?'. */
    text: string;
    /** Куски шаблона как массив. */
    strings: string[];
    /** Интерполированные аргументы. */
    args: unknown[];
  }
  interface QueuedResult {
    /** Подстрока SQL, на которую срабатывает этот ответ (по первому совпадению). */
    match: string;
    /** Что вернуть (массив строк) либо ошибку (если throwUnique=true). */
    rows?: unknown[];
    /** Бросить PG-нарушение уникальности (code 23505) вместо результата. */
    throwUnique?: boolean;
    /** Бросить произвольную ошибку. */
    throwError?: unknown;
    /** Сколько раз ещё применять этот ответ (по умолчанию бесконечно). */
    times?: number;
  }
  const state = {
    currentUser: null as AuthUser | null,
    sqlCalls: [] as SqlCall[],
    /** Управляемые ответы; ищется первый по подстроке match. */
    sqlResponses: [] as QueuedResult[],
    /** Сколько раз вызван sql.begin (атомарность attachMedia #3). */
    beginCalls: 0,
  };

  const PG_UNIQUE = '23505';

  function templateText(strings: TemplateStringsArray | string[]): string {
    return Array.from(strings).join('?');
  }

  // sql как tagged-template-спай. Записывает вызов и подбирает ответ по match.
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = templateText(strings);
    state.sqlCalls.push({ text, strings: Array.from(strings), args });
    for (const r of state.sqlResponses) {
      if (text.includes(r.match)) {
        if (typeof r.times === 'number') {
          if (r.times <= 0) continue;
          r.times -= 1;
        }
        if (r.throwUnique) {
          return Promise.reject(
            Object.assign(new Error('duplicate key value violates unique constraint'), {
              code: PG_UNIQUE,
            }),
          );
        }
        if (r.throwError !== undefined) {
          return Promise.reject(r.throwError);
        }
        return Promise.resolve(r.rows ?? []);
      }
    }
    return Promise.resolve([] as unknown[]);
  });
  (sqlMock as unknown as { json: unknown }).json = (v: unknown) => v;
  // sql.begin: tx — тот же спай (записи попадают в sqlCalls). Если коллбэк
  // бросает (напр. INSERT упал) — begin реджектит, имитируя ROLLBACK.
  (sqlMock as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => unknown) => {
    state.beginCalls += 1;
    return cb(sqlMock);
  };

  return {
    state,
    sqlMock,
    PG_UNIQUE,
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    getCurrentUserMock: vi.fn(async () => state.currentUser),
    rebuildCacheMock: vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>),
    rebuildVariantCacheMock: vi.fn(
      async (..._args: unknown[]) => ({}) as Record<string, unknown>,
    ),
    storagePutMock: vi.fn(async (key: string) => ({
      key,
      url: `https://cdn.test/${key}`,
      size: 1234,
    })),
    storageDeleteMock: vi.fn(async (..._args: unknown[]) => {}),
    validateUploadMock: vi.fn(async () => ({ ok: true, mime: 'image/webp' })),
    generatePreviewsMock: vi.fn(async () => ({
      main: { buffer: Buffer.from('webp'), width: 800, height: 600 },
    })),
  };
});

const { sqlMock } = H;

// --- vi.mock (hoisted) -------------------------------------------------------

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: H.getCurrentUserMock }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (...args: unknown[]) => H.writeAuditSpy(...(args as [])),
}));
vi.mock('@/lib/config/settings', () => ({ isModuleEffectivelyEnabled: async () => true }));
vi.mock('@/lib/db/client', () => ({ sql: H.sqlMock }));
vi.mock('@/lib/catalog/cache', () => ({
  rebuildProductAttributesCache: H.rebuildCacheMock,
  rebuildVariantAttributesCache: H.rebuildVariantCacheMock,
}));
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({ put: H.storagePutMock, delete: H.storageDeleteMock }),
}));
vi.mock('@/lib/storage/validate', () => ({ validateUpload: H.validateUploadMock }));
vi.mock('@/lib/storage/image', () => ({ generatePreviews: H.generatePreviewsMock }));

// Импорт actions ПОСЛЕ моков.
import {
  duplicateProduct,
  setProductAttributes,
  attachMedia,
  deleteMedia,
  reorderMedia,
  adjustInventory,
  setInventory,
} from '@/lib/catalog/actions';

// --- хелперы -----------------------------------------------------------------

function makeOwner(): AuthUser {
  return {
    id: 'u-1',
    email: 'owner@shop.io',
    isOwner: true,
    permissions: new Set<PermissionCode>(),
  };
}

const UUID = '11111111-1111-4111-8111-111111111111';
const VAR_A = '22222222-2222-4222-8222-222222222222';
const VAR_B = '33333333-3333-4333-8333-333333333333';
const ATTR_ID = '44444444-4444-4444-8444-444444444444';
const VAL_BLUE = '55555555-5555-4555-8555-555555555555';

/** Все статические куски всех sql-вызовов одной строкой (поиск фрагментов). */
function sqlText(): string {
  return H.state.sqlCalls.map((c) => c.text).join('||');
}

/** Находит первый sql-вызов, чей шаблон содержит подстроку. */
function findCall(match: string): { text: string; strings: string[]; args: unknown[] } | undefined {
  return H.state.sqlCalls.find((c) => c.text.includes(match));
}

/** Все sql-вызовы, чей шаблон содержит подстроку. */
function findCalls(match: string) {
  return H.state.sqlCalls.filter((c) => c.text.includes(match));
}

beforeEach(() => {
  H.state.currentUser = makeOwner();
  H.state.sqlCalls = [];
  H.state.sqlResponses = [];
  H.state.beginCalls = 0;
  sqlMock.mockClear();
  H.writeAuditSpy.mockClear();
  H.rebuildCacheMock.mockClear();
  H.storagePutMock.mockClear();
  H.storageDeleteMock.mockClear();
  H.validateUploadMock.mockClear();
  H.generatePreviewsMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// БАГ #10 — duplicateProduct: уникализация sku вариантов с ретраем на 23505.
//
// product_variants.sku имеет ГЛОБАЛЬНЫЙ UNIQUE (0007). Копирование вариантов
// литералом `sku || '-copy'` без суффикса попытки → повторное дублирование того
// же товара (или существующий '<sku>-copy') падает 23505 целиком.
// =============================================================================

describe('БАГ #10 — duplicateProduct уникализирует sku вариантов', () => {
  /** Источник товара для копирования (один SELECT products). */
  function seedSource() {
    H.state.sqlResponses.push({
      match: 'FROM products WHERE id =',
      rows: [
        {
          id: UUID,
          sku: 'ABC',
          slug: 'abc',
          name: 'Товар',
          description: '',
          base_price: '100.00',
          compare_at_price: null,
          is_featured: false,
          is_new: null,
          brand_id: null,
          seo_title: null,
          seo_description: null,
          weight_g: null,
          length_cm: null,
          width_cm: null,
          height_cm: null,
        },
      ],
    });
    // INSERT products RETURNING id → новая строка.
    H.state.sqlResponses.push({
      match: 'INSERT INTO products',
      rows: [{ id: 'new-prod' }],
    });
  }

  it('#10: повторное дублирование (sku вариантов в конфликте) проходит — INSERT вариантов ретраится на 23505', async () => {
    seedSource();
    // Первая попытка вставки ВАРИАНТОВ → конфликт по product_variants_sku_uniq;
    // вторая (с уникализированным sku) → успех. Если фикса нет — конфликт
    // не ретраится и операция падает сырой ошибкой → res.ok === false.
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_variants',
      throwUnique: true,
      times: 1,
    });

    const res = await duplicateProduct({ id: UUID });

    expect(res.ok, 'дублирование должно пережить конфликт sku вариантов').toBe(true);
    // Повторная вставка вариантов должна была произойти (ретрай).
    expect(findCalls('INSERT INTO product_variants').length).toBeGreaterThanOrEqual(2);
  });

  it('#10: happy-path без конфликта — копия создаётся за одну вставку вариантов', async () => {
    seedSource();
    const res = await duplicateProduct({ id: UUID });
    expect(res.ok).toBe(true);
    // Без конфликта — ровно одна вставка вариантов (ретрай не понадобился).
    expect(findCalls('INSERT INTO product_variants').length).toBe(1);
  });

  it('#10: INSERT вариантов НЕ использует «голый» литерал sku || \'-copy\' без уникализации попытки', async () => {
    seedSource();
    // Конфликт на первой вставке вариантов, чтобы заставить код искать
    // уникальный кандидат sku варианта.
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_variants',
      throwUnique: true,
      times: 1,
    });

    await duplicateProduct({ id: UUID });

    const variantInserts = findCalls('INSERT INTO product_variants');
    expect(variantInserts.length).toBeGreaterThanOrEqual(2);
    // Все INSERT-ы вариантов с фиксированным литералом sku || '-copy' (т.е. без
    // вариативности от попытки) приводили бы к бесконечному 23505. Признак
    // корректного фикса: либо в SQL появляется суффикс попытки, либо sku
    // кандидата передаётся аргументом и МЕНЯЕТСЯ между попытками.
    const literalCopyOnly = variantInserts.every(
      (c) => c.text.includes("|| '-copy'") && !/copy.*[-]?\$|attempt|\?\s*$/i.test(c.text),
    );
    const argsChange = (() => {
      const argSets = variantInserts.map((c) => JSON.stringify(c.args));
      return new Set(argSets).size > 1;
    })();
    // Должно различаться либо тело запроса (суффикс попытки), либо аргументы.
    const distinctBodies = new Set(variantInserts.map((c) => c.text)).size > 1;
    expect(distinctBodies || argsChange || !literalCopyOnly).toBe(true);
  });
});

// =============================================================================
// БАГ #11 — setProductAttributes: полная замена ТАКЖЕ для переданных вариантов.
//
// docstring обещает «полную замену привязок уровня товара И переданных вариантов»,
// но DELETE сносит только variant_id IS NULL. Привязки уровня варианта остаются,
// INSERT ... ON CONFLICT DO NOTHING; uniq включает value_id → смена select-значения
// варианта (Красный→Синий) добавляет второе значение, а не перезаписывает.
// =============================================================================

describe('БАГ #11 — setProductAttributes заменяет и привязки переданных вариантов', () => {
  it('#11: при наличии item с variantId выполняется DELETE привязок этого варианта (а не только variant_id IS NULL)', async () => {
    const res = await setProductAttributes({
      productId: UUID,
      items: [
        { attributeId: ATTR_ID, variantId: VAR_A, valueId: VAL_BLUE },
      ],
    });
    expect(res.ok).toBe(true);

    const deletes = findCalls('DELETE FROM product_attributes');
    const text = deletes.map((c) => c.text).join('||');
    // Должен быть DELETE, охватывающий переданные варианты (variant_id = ANY(...)
    // или явный список variant_id), а не только «variant_id IS NULL».
    const deletesVariantBindings =
      text.includes('variant_id = ANY') ||
      /variant_id\s*=\s*\?/.test(text) ||
      text.includes('variant_id IN');
    expect(
      deletesVariantBindings,
      'привязки переданного варианта должны удаляться перед вставкой (иначе ON CONFLICT DO NOTHING оставит старое значение)',
    ).toBe(true);
  });

  it('#11: distinct variantId из items попадают в аргументы DELETE-варианта', async () => {
    await setProductAttributes({
      productId: UUID,
      items: [
        { attributeId: ATTR_ID, variantId: VAR_A, valueId: VAL_BLUE },
        { attributeId: ATTR_ID, variantId: VAR_B, valueId: VAL_BLUE },
        // дубль варианта A — distinct не должен задваивать.
        { attributeId: ATTR_ID, variantId: VAR_A, valueText: 'X' },
      ],
    });

    // Среди аргументов любого DELETE FROM product_attributes должны быть оба варианта.
    const deletes = findCalls('DELETE FROM product_attributes');
    const allArgs = deletes.flatMap((c) => c.args);
    const flat = allArgs.flatMap((a) => (Array.isArray(a) ? a : [a]));
    expect(flat).toContain(VAR_A);
    expect(flat).toContain(VAR_B);
  });

  it('#11: без variant-item DELETE по вариантам не лишний — только уровень товара чистится', async () => {
    // items только уровня товара (без variantId) → DELETE по вариантам не нужен
    // с непустым списком; убеждаемся, что хотя бы DELETE variant_id IS NULL есть.
    await setProductAttributes({
      productId: UUID,
      items: [{ attributeId: ATTR_ID, valueText: 'Хлопок' }],
    });
    expect(sqlText()).toContain('variant_id IS NULL');
  });

  // --- C10-1 (цикл 10) — пересбор product_variants.attributes_cache ----------
  it('C10-1: с variant-item зовётся rebuildVariantAttributesCache(productId, [distinct variantIds])', async () => {
    H.rebuildVariantCacheMock.mockClear();
    await setProductAttributes({
      productId: UUID,
      items: [
        { attributeId: ATTR_ID, variantId: VAR_A, valueId: VAL_BLUE },
        { attributeId: ATTR_ID, variantId: VAR_B, valueId: VAL_BLUE },
        // дубль варианта A — список должен быть distinct.
        { attributeId: ATTR_ID, variantId: VAR_A, valueText: 'X' },
      ],
    });
    expect(H.rebuildVariantCacheMock).toHaveBeenCalledTimes(1);
    const [pid, vids] = H.rebuildVariantCacheMock.mock.calls[0] as [
      string,
      string[],
    ];
    expect(pid).toBe(UUID);
    expect([...vids].sort()).toEqual([VAR_A, VAR_B].sort());
  });

  it('C10-1: без variant-item кеш вариантов НЕ пересобирается (лишних запросов нет)', async () => {
    H.rebuildVariantCacheMock.mockClear();
    await setProductAttributes({
      productId: UUID,
      items: [{ attributeId: ATTR_ID, valueText: 'Хлопок' }],
    });
    expect(H.rebuildVariantCacheMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// БАГ #13 — attachMedia: при isPrimary снять прежнее главное перед INSERT.
//
// product_media_primary_uniq (0009) — частичный UNIQUE (product_id) WHERE is_primary.
// Загрузка нового primary при существующем primary → 23505 (сырая), файл уже в
// storage. ФИКС: UPDATE ... SET is_primary=false WHERE product_id=$1 AND is_primary
// перед INSERT (как reorderMedia).
// =============================================================================

describe('БАГ #2 (волна 15) — deleteMedia повышает новое главное при удалении главного', () => {
  const MEDIA_ID = '66666666-6666-4666-8666-666666666666';

  it('#2: удаление is_primary=true → UPDATE ... SET is_primary=true (повышение оставшегося)', async () => {
    H.state.sqlResponses.push({
      match: 'DELETE FROM product_media',
      rows: [{ id: MEDIA_ID, product_id: UUID, storage_key: 'k.webp', is_primary: true }],
    });
    const res = await deleteMedia({ id: MEDIA_ID });
    expect(res.ok).toBe(true);
    const promote = findCall('SET is_primary = true');
    expect(promote, 'удалив главное — повышаем следующее, иначе товар теряет обложку').toBeDefined();
    expect(promote!.text).toContain('SELECT id FROM product_media');
    expect(H.state.beginCalls).toBe(1); // атомарно (DELETE+промоут в одной транзакции)
  });

  it('#2: удаление НЕ главного (is_primary=false) → повышения нет', async () => {
    H.state.sqlResponses.push({
      match: 'DELETE FROM product_media',
      rows: [{ id: MEDIA_ID, product_id: UUID, storage_key: 'k.webp', is_primary: false }],
    });
    const res = await deleteMedia({ id: MEDIA_ID });
    expect(res.ok).toBe(true);
    expect(findCall('SET is_primary = true')).toBeUndefined();
  });
});

describe('БАГ #13 — attachMedia снимает прежнее главное при isPrimary', () => {
  const baseInput = () => ({
    productId: UUID,
    filename: 'p.jpg',
    bytes: Buffer.from('rawimage'),
    alt: 'фото',
    isPrimary: true,
  });

  it('#13: isPrimary=true → перед INSERT выполняется UPDATE product_media SET is_primary=false', async () => {
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_media',
      rows: [{ id: 'media-1' }],
    });
    const res = await attachMedia(baseInput());
    expect(res.ok).toBe(true);

    const clear = findCall('UPDATE product_media SET is_primary');
    expect(
      clear,
      'должен быть UPDATE, снимающий прежнее главное фото',
    ).toBeDefined();
    expect(clear!.text).toContain('is_primary');
    // Снятие должно идти ДО вставки нового primary.
    const idxClear = H.state.sqlCalls.findIndex((c) =>
      c.text.includes('UPDATE product_media SET is_primary'),
    );
    const idxInsert = H.state.sqlCalls.findIndex((c) =>
      c.text.includes('INSERT INTO product_media'),
    );
    expect(idxClear).toBeGreaterThanOrEqual(0);
    expect(idxClear).toBeLessThan(idxInsert);
  });

  it('#13: isPrimary=false → лишний UPDATE снятия главного НЕ выполняется', async () => {
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_media',
      rows: [{ id: 'media-2' }],
    });
    const res = await attachMedia({ ...baseInput(), isPrimary: false });
    expect(res.ok).toBe(true);
    expect(findCall('UPDATE product_media SET is_primary')).toBeUndefined();
  });

  it('C5-5: isPrimary=false → проверка наличия главного идёт под FOR UPDATE (сериализация attach↔delete)', async () => {
    // Без блокировки строки конкурентный deleteMedia (удаляющий последнее главное) мог
    // оставить товар без обложки. Проверка-авто-главное должна держать строку FOR UPDATE.
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_media',
      rows: [{ id: 'media-3' }],
    });
    const res = await attachMedia({ ...baseInput(), isPrimary: false });
    expect(res.ok).toBe(true);
    const lockSel = H.state.sqlCalls.find(
      (c) =>
        /SELECT id FROM product_media/i.test(c.text) &&
        /is_primary/i.test(c.text) &&
        /FOR UPDATE/i.test(c.text),
    );
    expect(lockSel, 'проверка наличия главного должна блокировать строку (FOR UPDATE)').toBeDefined();
  });

  it('#3: демоут+INSERT в ОДНОЙ транзакции — при сбое INSERT откат демоута, файл удалён', async () => {
    // INSERT падает → sql.begin реджектит → снятие is_primary не коммитится
    // (товар не остаётся без главного фото). Загруженный объект компенсируется.
    H.state.sqlResponses.push({
      match: 'INSERT INTO product_media',
      throwError: new Error('insert failed'),
    });
    const res = await attachMedia(baseInput());
    expect(res.ok).toBe(false); // defineAction свернёт в internal
    // Демоут и INSERT шли внутри sql.begin (атомарно).
    expect(H.state.beginCalls).toBeGreaterThanOrEqual(1);
    // Компенсация: загруженный в storage объект удалён.
    expect(H.storageDeleteMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// БАГ #14 — adjustInventory/setInventory: учёт reserved (CHECK reserved<=quantity).
//
// inventory_reserved_le_qty (0010). adjustInventory сейчас проверяет только
// quantity+delta>=0; setInventory ставит quantity безусловно. При reserved>0 и
// опускании quantity ниже reserved → сырой CHECK 23514. ФИКС: WHERE
// quantity+delta>=reserved (adjust) и EXCLUDED.quantity>=inventory.reserved (set),
// при пустом RETURNING — CatalogError('insufficient_stock').
// =============================================================================

describe('БАГ #14 — inventory учитывает reserved', () => {
  it('#14: adjustInventory несёт в WHERE условие против reserved (не только >= 0)', async () => {
    H.state.sqlResponses.push({
      match: 'INSERT INTO inventory',
      rows: [{ id: 'inv-1', quantity: 5 }],
    });
    const res = await adjustInventory({ productId: UUID, delta: -1 });
    expect(res.ok).toBe(true);
    const call = findCall('ON CONFLICT')!;
    expect(call.text).toContain('reserved');
  });

  it('#14: adjustInventory при 0 строк (итог < reserved) → отказ (insufficient_stock)', async () => {
    // INSERT ... RETURNING вернул [] → CatalogError('insufficient_stock').
    H.state.sqlResponses.push({ match: 'INSERT INTO inventory', rows: [] });
    const res = await adjustInventory({ productId: UUID, delta: -10 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    // CatalogError наследует PublicActionError → пайплайн отдаёт validation +
    // понятный message (доходит до UI), а не безликий internal.
    expect(res.error).toBe('validation');
    expect(res.message).toContain('списания');
  });

  it('m3: adjustInventory НЕ создаёт строку при delta<0 без существующего остатка (guard delta>=0 OR EXISTS)', async () => {
    // Нет существующей строки + отрицательная дельта → SELECT пуст → INSERT не
    // происходит → RETURNING пуст → отказ (раньше вставлялась quantity=0 + «успех»).
    H.state.sqlResponses.push({ match: 'INSERT INTO inventory', rows: [] });
    const res = await adjustInventory({ productId: UUID, delta: -5 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    // SQL гейтит создание НОВОЙ строки: delta>=0 ЛИБО строка уже существует.
    const ins = findCall('INSERT INTO inventory')!;
    expect(ins.text).toContain('EXISTS');
    expect(ins.text).toContain('>= 0');
    // ON CONFLICT для существующей строки сохранён (списание под защитой reserved).
    expect(ins.text).toContain('ON CONFLICT');
  });

  it('#14: setInventory несёт защиту reserved (EXCLUDED.quantity >= inventory.reserved)', async () => {
    H.state.sqlResponses.push({
      match: 'INSERT INTO inventory',
      rows: [{ id: 'inv-2', quantity: 3 }],
    });
    const res = await setInventory({ productId: UUID, quantity: 3 });
    expect(res.ok).toBe(true);
    const call = findCall('ON CONFLICT')!;
    expect(call.text).toContain('reserved');
  });

  it('#14: setInventory при 0 строк (quantity < reserved) → отказ (insufficient_stock), не сырой CHECK', async () => {
    H.state.sqlResponses.push({ match: 'INSERT INTO inventory', rows: [] });
    const res = await setInventory({ productId: UUID, quantity: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.message).toContain('зарезервированного');
  });
});

// =============================================================================
// m1 (цикл 2) — reorderMedia атомарен: перестановка sort + смена главного фото
// должны идти в ОДНОЙ транзакции (sql.begin). Иначе сбой между демоутом прежнего
// главного и промоутом нового оставил бы 0 главных (или частично переставленный
// порядок) — сиблинг бага #2 (deleteMedia уже в транзакции).
// =============================================================================

describe('m1 — reorderMedia атомарен (демоут+промоут главного в транзакции)', () => {
  const MEDIA_A = '77777777-7777-4777-8777-777777777777';
  const MEDIA_B = '88888888-8888-4888-8888-888888888888';

  it('m1: смена главного → демоут+промоут внутри sql.begin (beginCalls=1), демоут ДО промоута', async () => {
    const res = await reorderMedia({
      productId: UUID,
      order: [MEDIA_A, MEDIA_B],
      primaryId: MEDIA_B,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // Вся операция — в одной транзакции.
    expect(H.state.beginCalls).toBe(1);
    // Демоут прежнего главного и промоут нового присутствуют...
    expect(findCall('SET is_primary = false')).toBeDefined();
    expect(findCall('SET is_primary = true')).toBeDefined();
    // ...и демоут идёт ДО промоута.
    const demoteIdx = H.state.sqlCalls.findIndex((c) => c.text.includes('SET is_primary = false'));
    const promoteIdx = H.state.sqlCalls.findIndex((c) => c.text.includes('SET is_primary = true'));
    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(promoteIdx).toBeGreaterThan(demoteIdx);
  });

  it('m1: без primaryId → флаги is_primary не трогаются, но операция всё равно в транзакции', async () => {
    const res = await reorderMedia({ productId: UUID, order: [MEDIA_A, MEDIA_B] });
    expect(res.ok).toBe(true);
    expect(H.state.beginCalls).toBe(1);
    expect(findCall('SET is_primary')).toBeUndefined();
  });
});
