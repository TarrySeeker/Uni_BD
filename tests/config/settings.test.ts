import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  mergeSettings,
  getEffectiveSettings,
  invalidateSettingsCache,
  getEffectiveModules,
  type EffectiveSettings,
} from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';
import { getEnabledModules, ALL_MODULES } from '@/lib/config/modules';
import { toMinor, fromMinor } from '@/lib/orders/money';
import { listMigrations } from '@/lib/db/migrate';

/**
 * Тесты пакета 5.D-1 (docs/11 §5.4.6, §8) — фундамент DB-driven настроек.
 *
 * (а) ЮНИТ — чистый слой merge/модулей/денег/кеша. Без БД, всегда зелёные.
 * (б) ИНТЕГРАЦИЯ (skipIf без DATABASE_URL) — идемпотентность миграций 0019/0020.
 *
 * env-дефолт ⊕ строка БД: env = дефолт, БД = частичный оверрайд на уровне полей.
 */

// =============================================================================
// Хелперы.
// =============================================================================

/** env с фиксированными дефолтами для предсказуемого мерджа. */
function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({
    NODE_ENV: 'test',
    SHOP_NAME: 'EnvShop',
    SHOP_CURRENCY: 'RUB',
    SHOP_NEW_PRODUCT_DAYS: '30',
    SHOP_FREE_DELIVERY_THRESHOLD: '0',
    SHOP_ORDER_PREFIX: '',
    ...overrides,
  });
}

// =============================================================================
// (а) ЮНИТ — mergeSettings (env ⊕ БД).
// =============================================================================
describe('config/settings — mergeSettings (env ⊕ БД)', () => {
  it('пустая БД → берётся целиком env-дефолт', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.branding.shopName).toBe('EnvShop');
    expect(eff.currency.code).toBe('RUB');
    expect(eff.catalog.newProductDays).toBe(30);
    // freeDeliveryThreshold в копейках; env 0 руб → 0 коп.
    expect(eff.delivery.freeDeliveryThreshold).toBe(0);
  });

  it('пустой объект {} в строке БД → трактуется как «нет оверрайда» → env', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'branding', value: {} },
      { setting_key: 'currency', value: {} },
    ]);
    expect(eff.branding.shopName).toBe('EnvShop');
    expect(eff.currency.code).toBe('RUB');
  });

  it('частичный оверрайд: только branding.shopName меняется, остальное из env', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'branding', value: { shopName: 'DbShop' } },
    ]);
    expect(eff.branding.shopName).toBe('DbShop');
    // currency/catalog/delivery не трогались → env.
    expect(eff.currency.code).toBe('RUB');
    expect(eff.catalog.newProductDays).toBe(30);
  });

  it('полный оверрайд: значения из БД полностью замещают env-дефолты', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'branding', value: { shopName: 'FullShop', supportEmail: 'a@b.ru' } },
      { setting_key: 'currency', value: { code: 'USD', symbol: '$', fractionDigits: 2 } },
      { setting_key: 'catalog', value: { newProductDays: 7 } },
      { setting_key: 'delivery', value: { freeDeliveryThreshold: 300000 } },
      { setting_key: 'orders', value: { orderPrefix: 'GA' } },
    ]);
    expect(eff.branding.shopName).toBe('FullShop');
    expect(eff.branding.supportEmail).toBe('a@b.ru');
    expect(eff.currency.code).toBe('USD');
    expect(eff.catalog.newProductDays).toBe(7);
    expect(eff.delivery.freeDeliveryThreshold).toBe(300000);
    expect(eff.orders.orderPrefix).toBe('GA');
  });

  it('logoUrl: плейсхолдер example.com → null (не рендерим битую картинку в шапке)', () => {
    // Из .env.example в .env часто попадает SHOP_LOGO_URL=https://example.com/logo.svg.
    const effEnv = mergeSettings(envWith({ SHOP_LOGO_URL: 'https://example.com/logo.svg' }), []);
    expect(effEnv.branding.logoUrl).toBeNull();
    // Тот же плейсхолдер в БД — тоже null.
    const effDb = mergeSettings(envWith(), [
      { setting_key: 'branding', value: { logoUrl: 'https://example.com/logo.svg' } },
    ]);
    expect(effDb.branding.logoUrl).toBeNull();
  });

  it('logoUrl: валидный https URL сохраняется как есть', () => {
    const eff = mergeSettings(envWith({ SHOP_LOGO_URL: 'https://cdn.shop.ru/logo.svg' }), []);
    expect(eff.branding.logoUrl).toBe('https://cdn.shop.ru/logo.svg');
  });

  it('лишние/неизвестные поля в value отбрасываются Zod', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'branding',
        value: { shopName: 'DbShop', hacker: 'drop table', __proto__: { x: 1 } },
      },
    ]);
    expect(eff.branding.shopName).toBe('DbShop');
    expect((eff.branding as Record<string, unknown>).hacker).toBeUndefined();
  });

  it('невалидное value (тип не проходит Zod) → раздел игнорируется, остаётся env', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'catalog', value: { newProductDays: 'not-a-number' } },
    ]);
    // невалидный раздел не ломает остальное и падает на env.
    expect(eff.catalog.newProductDays).toBe(30);
  });

  it('является чистой функцией: один и тот же вход → один и тот же результат', () => {
    const env = envWith();
    const rows = [{ setting_key: 'branding', value: { shopName: 'X' } }];
    const a = mergeSettings(env, rows);
    const b = mergeSettings(env, rows);
    expect(a).toEqual(b);
  });
});

// =============================================================================
// (а) ЮНИТ — getEffectiveModules (env ⊕ module_overrides).
// =============================================================================
describe('config/settings — getEffectiveModules', () => {
  it('env=all + override{orders:false} → orders выключен, остальные включены', () => {
    const env = { ADMIK_MODULES: undefined };
    const mods = getEffectiveModules(env, { orders: false });
    expect(mods).not.toContain('orders');
    expect(mods).toContain('catalog');
    expect(mods).toContain('cdek');
    expect(mods).toContain('cms');
  });

  it("env='catalog' + override{cms:true} → catalog + cms", () => {
    const env = { ADMIK_MODULES: 'catalog' };
    const mods = getEffectiveModules(env, { cms: true });
    expect(mods.sort()).toEqual(['catalog', 'cms']);
  });

  it('пустой override → ровно getEnabledModules(env)', () => {
    const env = { ADMIK_MODULES: 'catalog,orders' };
    expect(getEffectiveModules(env, {}).sort()).toEqual(getEnabledModules(env).sort());
  });

  it('undefined override → ровно getEnabledModules(env)', () => {
    const env = { ADMIK_MODULES: 'catalog,cms' };
    expect(getEffectiveModules(env).sort()).toEqual(getEnabledModules(env).sort());
  });

  it('override всех модулей в false при env=all → пусто', () => {
    const env = { ADMIK_MODULES: undefined };
    // Выключаем КАЖДЫЙ модуль платформы (производно от ALL_MODULES — тест не
    // ломается при добавлении нового модуля, напр. payments).
    const allFalse = Object.fromEntries(ALL_MODULES.map((m) => [m, false]));
    const mods = getEffectiveModules(env, allFalse);
    expect(mods).toEqual([]);
  });

  it('включение через override модуля, отсутствующего в env-наборе', () => {
    const env = { ADMIK_MODULES: 'catalog' };
    const mods = getEffectiveModules(env, { orders: true, cdek: true });
    expect(mods.sort()).toEqual(['catalog', 'cdek', 'orders']);
  });

  it('детерминированный результат — подмножество ALL_MODULES без дублей', () => {
    const env = { ADMIK_MODULES: undefined };
    const mods = getEffectiveModules(env, { cms: true });
    const set = new Set(mods);
    expect(set.size).toBe(mods.length);
    for (const m of mods) expect(ALL_MODULES).toContain(m);
  });
});

// =============================================================================
// (а) ЮНИТ — кеш-мемоизация getEffectiveSettings + инвалидация.
// =============================================================================
describe('config/settings — кеш getEffectiveSettings / invalidate', () => {
  afterEach(() => {
    invalidateSettingsCache();
  });

  it('два чтения подряд → один вызов reader (мемоизация)', async () => {
    const reader = vi.fn(async () => [{ setting_key: 'branding', value: { shopName: 'Memo' } }]);
    const first = await getEffectiveSettings({ readRows: reader, env: envWith() });
    const second = await getEffectiveSettings({ readRows: reader, env: envWith() });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(first.branding.shopName).toBe('Memo');
    expect(second).toBe(first); // тот же мемоизированный объект
  });

  it('после invalidateSettingsCache → новый вызов reader', async () => {
    const reader = vi.fn(async () => [{ setting_key: 'branding', value: { shopName: 'V1' } }]);
    await getEffectiveSettings({ readRows: reader, env: envWith() });
    expect(reader).toHaveBeenCalledTimes(1);

    invalidateSettingsCache();
    reader.mockResolvedValueOnce([{ setting_key: 'branding', value: { shopName: 'V2' } }]);
    const after = await getEffectiveSettings({ readRows: reader, env: envWith() });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(after.branding.shopName).toBe('V2');
  });

  it('TOCTOU: invalidate во время in-flight read НЕ оставляет stale в кеше (epoch-guard)', async () => {
    // Управляемый отложенный резолв первого чтения (deferred), чтобы смоделировать
    // зависший SELECT, снятый ДО коммита параллельной записи настроек.
    let releaseRead!: (rows: { setting_key: string; value: Record<string, unknown> }[]) => void;
    const firstRead = new Promise<{ setting_key: string; value: Record<string, unknown> }[]>((resolve) => {
      releaseRead = resolve;
    });

    const reader = vi
      .fn<() => Promise<{ setting_key: string; value: Record<string, unknown> }[]>>()
      // 1-е чтение — зависший SELECT, видит СТАРЫЙ снапшот (V1).
      .mockImplementationOnce(() => firstRead)
      // 2-е чтение (после инвалидации) — уже видит НОВЫЙ снапшот (V2).
      .mockImplementationOnce(async () => [{ setting_key: 'branding', value: { shopName: 'V2' } }]);

    // Запрос A стартует чтение и подвисает на await read().
    const pendingA = getEffectiveSettings({ readRows: reader, env: envWith() });

    // Пока A ждёт — параллельная запись настроек инвалидирует кеш (cached=undefined).
    invalidateSettingsCache();

    // Теперь зависший SELECT запроса A резолвится УСТАРЕВШИМ снапшотом (V1).
    releaseRead([{ setting_key: 'branding', value: { shopName: 'V1' } }]);
    const resultA = await pendingA;
    // Вызывающий получает то, что прочитал (merged), но кешировать stale нельзя.
    expect(resultA.branding.shopName).toBe('V1');

    // Следующий вызов ОБЯЗАН перечитать БД (а не вернуть закешированный stale V1).
    const after = await getEffectiveSettings({ readRows: reader, env: envWith() });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(after.branding.shopName).toBe('V2');
  });

  it('кэш живёт на globalThis (общий для всех бандлов Next) — инвалидация видна «другому экземпляру»', async () => {
    // Регрессия бага «правка в админке не видна на витрине»: Next инстанцирует
    // lib/config/settings в РАЗНЫХ бандлах (server-action vs route-handler). Если
    // состояние держать в модульных `let`, у каждого бандла свой memo и
    // invalidate из экшена НЕ достанет до кэша, который читает публичный API.
    // Поэтому состояние обязано лежать на globalThis под общим registry-Symbol.
    const reader = vi.fn(async () => [{ setting_key: 'branding', value: { shopName: 'G1' } }]);
    await getEffectiveSettings({ readRows: reader, env: envWith() });

    // «Другой экземпляр модуля» дотягивается до того же состояния через globalThis.
    const slot = (globalThis as unknown as Record<symbol, { cached?: unknown } | undefined>)[
      Symbol.for('admik.config.settings.effectiveCache')
    ];
    expect(slot).toBeDefined();
    expect(slot!.cached).toBeDefined();

    // Инвалидация (как из settings-action) немедленно видна через тот же слот.
    invalidateSettingsCache();
    expect(slot!.cached).toBeUndefined();
  });
});

// =============================================================================
// (а) ЮНИТ — деньги: freeDeliveryThreshold рубли → копейки round-trip без float.
// =============================================================================
describe('config/settings — деньги (копейки, без float)', () => {
  it('рубли → копейки → рубли round-trip', () => {
    const minor = toMinor('3000.00'); // 3000 руб
    expect(minor).toBe(300000);
    expect(fromMinor(minor)).toBe('3000.00');
  });

  it('freeDeliveryThreshold хранится в копейках (int) в эффективных настройках', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'delivery', value: { freeDeliveryThreshold: toMinor('1999.99') } },
    ]);
    expect(eff.delivery.freeDeliveryThreshold).toBe(199999);
    expect(Number.isInteger(eff.delivery.freeDeliveryThreshold)).toBe(true);
  });

  it('копеечное значение без потерь float (0.1 + 0.2 проблема не возникает)', () => {
    const minor = toMinor('0.30');
    expect(minor).toBe(30);
    expect(fromMinor(toMinor('0.10') + toMinor('0.20'))).toBe('0.30');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — идемпотентность миграций 0019/0020.
//     Юнит-часть (файлы на диске) проходит ВСЕГДА; накат в БД — skipIf.
// =============================================================================
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

const SETTINGS_VERSIONS = ['0019', '0020'] as const;

async function listSettingsMigrations() {
  const all = await listMigrations();
  return all.filter((m) => (SETTINGS_VERSIONS as readonly string[]).includes(m.version));
}

describe('db/migrations — настройки 0019/0020 (юнит, файлы на диске)', () => {
  it('миграции 0019/0020 существуют и названы по контракту', async () => {
    const rows = await listSettingsMigrations();
    const byVersion = Object.fromEntries(rows.map((m) => [m.version, m.name]));
    expect(byVersion['0019']).toBe('shop_settings');
    expect(byVersion['0020']).toBe('shop_settings_seed');
  });

  it('нумерация сплошная, продолжает 0018 без пропусков', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    expect(versions).toContain('0019');
    expect(versions).toContain('0020');
  });

  it('все CREATE TABLE используют IF NOT EXISTS (идемпотентность)', async () => {
    for (const m of await listSettingsMigrations()) {
      const upper = stripSqlComments(await readFile(m.path, 'utf8')).toUpperCase();
      const creates = upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/g) ?? [];
      const guarded =
        upper.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/g) ?? [];
      expect(guarded.length, `в ${m.name} есть незащищённый CREATE`).toBe(creates.length);
    }
  });

  it('0019: CHECK jsonb_typeof через DO-блок + pg_constraint (нет ADD CONSTRAINT без guard)', async () => {
    const m = (await listSettingsMigrations()).find((x) => x.version === '0019')!;
    const text = await readFile(m.path, 'utf8');
    expect(text).toMatch(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/i);
    expect(text).toMatch(/jsonb_typeof/i);
    expect(text).toMatch(/ADD\s+CONSTRAINT/i);
  });

  it('0019 выдаёт полный DML-грант (S/I/U/D) на shop_settings роли admik_app', async () => {
    const m = (await listSettingsMigrations()).find((x) => x.version === '0019')!;
    const upper = stripSqlComments(await readFile(m.path, 'utf8')).toUpperCase();
    expect(upper).toMatch(
      /GRANT\s+SELECT,\s+INSERT,\s+UPDATE,\s+DELETE\s+ON\s+SHOP_SETTINGS\s+TO\s+ADMIK_APP/,
    );
  });

  it('0020 seed идемпотентен: ON CONFLICT DO NOTHING (не DO UPDATE)', async () => {
    const m = (await listSettingsMigrations()).find((x) => x.version === '0020')!;
    const upper = stripSqlComments(await readFile(m.path, 'utf8')).toUpperCase();
    expect(upper).toContain('ON CONFLICT (SETTING_KEY) DO NOTHING');
    expect(upper).not.toContain('DO UPDATE');
  });

  it('каждая миграция пишет свою версию в schema_migrations ON CONFLICT DO NOTHING', async () => {
    for (const m of await listSettingsMigrations()) {
      const text = await readFile(m.path, 'utf8');
      expect(text).toContain('schema_migrations');
      expect(text).toContain(`'${m.version}'`);
      expect(text.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
    }
  });
});

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('db/migrations — настройки (интеграция, накат в БД)', () => {
  let postgres: any;
  let listMigrationsFn: typeof listMigrations;
  let sql: any;

  function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  async function applyAllMigrations(): Promise<void> {
    const migrations = await listMigrationsFn();
    const appPassword = process.env.APP_PASSWORD ?? 'app_test_password';
    const migratorPassword = process.env.MIGRATOR_PASSWORD ?? 'migrator_test_password';
    for (const migration of migrations) {
      let text = await readFile(migration.path, 'utf8');
      text = text
        .replaceAll(":'APP_PASSWORD'", quoteLiteral(appPassword))
        .replaceAll(":'MIGRATOR_PASSWORD'", quoteLiteral(migratorPassword));
      await sql.unsafe(text);
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!postgres) {
      postgres = (await import('postgres')).default;
      const mod: typeof import('@/lib/db/migrate') = await import('@/lib/db/migrate');
      listMigrationsFn = mod.listMigrations;
    }
    if (!sql) {
      sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
    }
  }

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('двойной накат всех миграций (включая 0019/0020) не падает', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const first = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    await applyAllMigrations();
    const second = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    expect(second).toEqual(first);
    const versions = second.map((r: { version: string }) => r.version);
    for (const v of SETTINGS_VERSIONS) expect(versions).toContain(v);
  });

  it('таблица shop_settings создана, seed-ключи проставлены пустыми {}', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const rows = await sql`SELECT setting_key, value FROM shop_settings ORDER BY setting_key`;
    const keys = rows.map((r: { setting_key: string }) => r.setting_key);
    for (const k of ['branding', 'currency', 'units', 'module_overrides', 'seo']) {
      expect(keys).toContain(k);
    }
  });

  it('CHECK jsonb_typeof: запись не-объекта в value отклоняется', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    await expect(
      sql`INSERT INTO shop_settings (setting_key, value) VALUES ('bad_check', '[]'::jsonb)`,
    ).rejects.toThrow();
    await sql`DELETE FROM shop_settings WHERE setting_key = 'bad_check'`;
  });

  it('admik_app имеет полный DML на shop_settings', async () => {
    await ensureLoaded();
    await applyAllMigrations();
    const [priv] = await sql`
      SELECT
        has_table_privilege('admik_app','shop_settings','SELECT') AS s,
        has_table_privilege('admik_app','shop_settings','INSERT') AS i,
        has_table_privilege('admik_app','shop_settings','UPDATE') AS u,
        has_table_privilege('admik_app','shop_settings','DELETE') AS d
    `;
    expect([priv.s, priv.i, priv.u, priv.d]).toEqual([true, true, true, true]);
  });
});
