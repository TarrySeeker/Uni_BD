import { describe, it, expect, vi } from 'vitest';

import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  createSettingsActions,
  type SettingsActionDeps,
} from '@/lib/settings/action-factory';
import { homeSchema } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import { getEnv } from '@/lib/config/env';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты ADR-018 «контент главной» (home).
 *
 * (а) homeSchema — валидация/strip/опциональность блоков hero/about/quality/delivery.
 * (б) mergeSettings — пустая БД → home = HOME_DEFAULTS (фолбэк = текущая витрина);
 *     частичный оверрайд блока заменяет блок целиком (JSONB-семантика value).
 * (в) DTO — home отдаётся наружу (без приватного).
 * (г) updateHomeAction — guard/Zod/upsert(home)/audit/invalidate.
 */

// -----------------------------------------------------------------------------
// Хелперы (как tests/settings/actions.test.ts).
// -----------------------------------------------------------------------------

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'admin@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeActionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function makeSettingsDeps(
  actionDeps: ActionDeps,
  overrides: Partial<SettingsActionDeps> = {},
): SettingsActionDeps {
  return {
    actionDeps,
    upsertSetting: vi.fn(async (key: string, value: Record<string, unknown>) => ({
      setting_key: key,
      value,
      updated_at: new Date('2026-06-23T00:00:00Z'),
      updated_by: 'u-1',
    })),
    deleteSetting: vi.fn(async () => true),
    getSetting: vi.fn(async () => null),
    invalidateCache: vi.fn(() => {}),
    hasPublishedCmsPages: vi.fn(async () => false),
    validateUpload: vi.fn(async () => ({ ok: true, mime: 'image/webp' as const })),
    generatePreviews: vi.fn(async () => ({
      main: { buffer: Buffer.from('webp'), width: 800, height: 600, format: 'webp' },
      thumbnail: { buffer: Buffer.from('webp'), width: 320, height: 240, format: 'webp' },
    })),
    getStorage: vi.fn(() => ({
      mode: 'local' as const,
      put: vi.fn(async (key: string) => ({ key, url: `https://cdn.test/${key}`, size: 1234 })),
      get: vi.fn(),
      delete: vi.fn(async () => {}),
      url: (key: string) => `https://cdn.test/${key}`,
    })),
    ...overrides,
  };
}

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB', ...overrides });
}

// =============================================================================
// (а) homeSchema.
// =============================================================================
describe('settings/schemas — homeSchema', () => {
  it('пустой объект валиден (все блоки опциональны)', () => {
    expect(homeSchema.safeParse({}).success).toBe(true);
  });

  it('strip: отбрасывает неизвестные поля верхнего уровня', () => {
    const parsed = homeSchema.parse({ hero: { title: 'X' }, bogus: 1, evil: { a: 2 } });
    expect(parsed).toEqual({ hero: { title: 'X' } });
    expect('bogus' in parsed).toBe(false);
  });

  it('hero/about/quality/delivery принимают именованные поля', () => {
    const parsed = homeSchema.parse({
      hero: { title: 'T', subtitle: 'S', imageKey: 'home/h.webp', ctaLabel: 'GO', ctaHref: '/catalog' },
      about: { title: 'О бренде', paragraphs: ['p1', 'p2'], imageKeys: ['a.webp'], values: ['v1'] },
      quality: { title: 'Качество', items: ['i1', 'i2'] },
      delivery: { items: [{ title: 'СДЭК', text: 'описание' }] },
    });
    expect(parsed.hero?.title).toBe('T');
    expect(parsed.about?.paragraphs).toEqual(['p1', 'p2']);
    expect(parsed.quality?.items).toEqual(['i1', 'i2']);
    expect(parsed.delivery?.items?.[0]).toEqual({ title: 'СДЭК', text: 'описание' });
  });

  it('delivery.items требует title и text у каждого пункта', () => {
    expect(homeSchema.safeParse({ delivery: { items: [{ title: 'X' }] } }).success).toBe(false);
  });
});

// =============================================================================
// (б) mergeSettings — home с дефолтами.
// =============================================================================
describe('config/settings — home merge', () => {
  it('пустая БД → home = HOME_DEFAULTS (фолбэк витрины)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.home).toEqual(HOME_DEFAULTS);
    // дефолты непустые — совпадают с текущей витриной.
    expect(eff.home.about.title).toBe('О бренде');
    expect(eff.home.quality.items.length).toBeGreaterThan(0);
    expect(eff.home.delivery.items.length).toBe(3);
  });

  it('частичный оверрайд блока hero → hero заменён, остальные блоки = дефолт', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { hero: { title: 'Новый герой' } } },
    ]);
    expect(eff.home.hero.title).toBe('Новый герой');
    // about/quality/delivery не трогались → дефолты.
    expect(eff.home.about.title).toBe(HOME_DEFAULTS.about.title);
    expect(eff.home.delivery.items).toEqual(HOME_DEFAULTS.delivery.items);
  });

  it('кривая строка БД (невалидный home) → дефолты (merge не падает)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { delivery: { items: [{ title: 'X' }] } } },
    ]);
    expect(eff.home).toEqual(HOME_DEFAULTS);
  });
});

// =============================================================================
// (в) DTO — home наружу.
// =============================================================================
describe('storefront/settings-dto — home', () => {
  it('DTO содержит home (hero/about/quality/delivery)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'home', value: { hero: { title: 'Герой' } } },
    ]);
    const dto = toPublicSettingsDto(eff);
    expect(dto.home).toBeDefined();
    expect(dto.home.hero.title).toBe('Герой');
    expect(dto.home.about.title).toBe(HOME_DEFAULTS.about.title);
    expect(dto.home.delivery.items).toEqual(HOME_DEFAULTS.delivery.items);
  });

  it('изображения home отдаются как URL (резолв ключей через publicUrl, ключи наружу не утекают)', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'home',
        value: { hero: { imageKey: 'home/h.webp' }, about: { imageKeys: ['a1.webp', 'a2.webp'] } },
      },
    ]);
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn.test/${k}`);
    expect(dto.home.hero.imageUrl).toBe('https://cdn.test/home/h.webp');
    expect(dto.home.about.imageUrls).toEqual([
      'https://cdn.test/a1.webp',
      'https://cdn.test/a2.webp',
    ]);
    // сырые ключи наружу не раскрываются
    const json = JSON.stringify(dto.home);
    expect(json).not.toContain('imageKey');
    expect(json).not.toContain('"home/h.webp"');
  });
});

// =============================================================================
// (г) updateHomeAction.
// =============================================================================
describe('settings/actions — updateHomeAction', () => {
  it('без settings.manage → forbidden', async () => {
    const actionDeps = makeActionDeps(makeUser(['catalog.write']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateHomeAction } = createSettingsActions(deps);
    const res = await updateHomeAction({ home: { hero: { title: 'X' } } });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });

  it('успех: upsert(home) + invalidate + audit', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateHomeAction } = createSettingsActions(deps);
    const res = await updateHomeAction({
      home: { hero: { title: 'Герой' }, quality: { items: ['a', 'b'] } },
    });
    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'home',
      expect.objectContaining({ hero: { title: 'Герой' } }),
      'u-1',
    );
    expect(deps.invalidateCache).toHaveBeenCalled();
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.home.update');
  });

  it('невалидный delivery-пункт → validation, репозиторий не тронут', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateHomeAction } = createSettingsActions(deps);
    const res = await updateHomeAction({ home: { delivery: { items: [{ title: 'X' }] } } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});

// =============================================================================
// navigation (G-10/G-11) — меню шапки + колонки футера.
// =============================================================================
describe('navigation (G-10/G-11)', () => {
  it('пустая БД → navigation пустой', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.navigation).toEqual({ header: [], footer: [] });
  });

  it('оверрайд → header/footer из БД + проброс в DTO', () => {
    const eff = mergeSettings(envWith(), [
      {
        setting_key: 'navigation',
        value: {
          header: [{ label: 'Каталог', href: '/catalog' }],
          footer: [{ title: 'Сервис', links: [{ label: 'Доставка', href: '/d' }] }],
        },
      },
    ]);
    expect(eff.navigation.header).toEqual([{ label: 'Каталог', href: '/catalog' }]);
    expect(eff.navigation.footer[0]!.title).toBe('Сервис');
    const dto = toPublicSettingsDto(eff);
    expect(dto.navigation.header).toEqual([{ label: 'Каталог', href: '/catalog' }]);
    expect(dto.navigation.footer[0]!.links[0]).toEqual({ label: 'Доставка', href: '/d' });
  });

  it('updateNavigationAction: guard settings.manage + upsert + audit', async () => {
    const actionDeps = makeActionDeps(makeUser(['settings.manage']));
    const deps = makeSettingsDeps(actionDeps);
    const { updateNavigationAction } = createSettingsActions(deps);
    const res = await updateNavigationAction({ navigation: { header: [{ label: 'X', href: '/x' }] } });
    expect(res.ok).toBe(true);
    expect(deps.upsertSetting).toHaveBeenCalledWith(
      'navigation',
      expect.objectContaining({ header: [{ label: 'X', href: '/x' }] }),
      'u-1',
    );
    const auditArg = (actionDeps.writeAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('settings.navigation.update');
  });

  it('updateNavigationAction без прав → forbidden', async () => {
    const deps = makeSettingsDeps(makeActionDeps(makeUser(['catalog.write'])));
    const { updateNavigationAction } = createSettingsActions(deps);
    const res = await updateNavigationAction({ navigation: { header: [] } });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(deps.upsertSetting).not.toHaveBeenCalled();
  });
});
