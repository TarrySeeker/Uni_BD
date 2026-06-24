import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NAV, buildAdminNav, type NavItem } from '@/lib/admin/nav';
import {
  buildPermissionSet,
  type AuthUser,
} from '@/lib/auth/rbac';
import { SYSTEM_ROLES } from '@/lib/auth/permissions';
import { getEnabledModules } from '@/lib/config/modules';

/**
 * Юнит-тесты чистой логики состава меню (docs/04 §6.3).
 *
 * buildAdminNav теперь принимает ЭФФЕКТИВНЫЙ набор модулей (env ⊕ БД-оверрайд),
 * который вычисляет вызывающий (layout: getEffectiveModuleSet()). В тестах набор
 * детерминированно строим из env через getEnabledModules(env) — так проверки
 * фильтрации по модулям остаются прежними, но без чтения БД внутри nav.
 */
function modulesFromEnv(env?: Record<string, string | undefined>) {
  return getEnabledModules(env);
}

/** Находит определение системной роли по коду. */
function role(code: 'owner' | 'admin' | 'manager') {
  const def = SYSTEM_ROLES.find((r) => r.code === code);
  if (!def) throw new Error(`Роль ${code} не найдена в SYSTEM_ROLES`);
  return def;
}

/** Конструирует тестового пользователя из набора системных ролей. */
function makeUser(opts: {
  isOwner?: boolean;
  roles?: ('owner' | 'admin' | 'manager')[];
}): AuthUser {
  return {
    id: 'u1',
    email: 'test@example.com',
    isOwner: opts.isOwner ?? false,
    permissions: buildPermissionSet((opts.roles ?? []).map(role)),
  };
}

/** Метки пунктов меню по результату фильтрации. */
function labels(items: NavItem[]): string[] {
  return items.map((i) => i.label);
}

describe('admin/nav — buildAdminNav', () => {
  it('owner видит все пункты при всех включённых модулях', () => {
    const owner = makeUser({ isOwner: true });
    // Пустой env → набор включает все модули по умолчанию.
    const result = buildAdminNav(owner, modulesFromEnv({}));
    expect(result).toHaveLength(NAV.length);
    expect(labels(result)).toEqual(labels([...NAV]));
  });

  it('при ADMIK_MODULES без catalog пункт «Каталог» скрыт даже у owner', () => {
    const owner = makeUser({ isOwner: true });
    const result = buildAdminNav(owner, modulesFromEnv({
      ADMIK_MODULES: 'orders,cdek,cms',
    }));
    expect(labels(result)).not.toContain('Каталог');
    // Остальные модульные пункты остаются у владельца.
    expect(labels(result)).toContain('Заказы');
    expect(labels(result)).toContain('Доставка');
    expect(labels(result)).toContain('Контент');
  });

  it('пользователь без права audit.read не видит «Аудит»', () => {
    // admin имеет audit.read; уберём его, оставив только catalog.read.
    const user = makeUser({});
    user.permissions = buildPermissionSet([
      { permissions: ['catalog.read'] },
    ]);
    const result = buildAdminNav(user, modulesFromEnv({}));
    expect(labels(result)).not.toContain('Аудит');
    expect(labels(result)).toContain('Каталог');
  });

  it('manager видит «Заказы» и «Промокоды», но не видит «Пользователи»', () => {
    const manager = makeUser({ roles: ['manager'] });
    const result = buildAdminNav(manager, modulesFromEnv({}));
    expect(labels(result)).toContain('Заказы');
    // «Промокоды» — пункт модуля orders под правом orders.write (есть у manager).
    expect(labels(result)).toContain('Промокоды');
    expect(labels(result)).not.toContain('Пользователи');
    // manager не имеет roles.manage / users.read → нет Ролей и Пользователей.
    expect(labels(result)).not.toContain('Роли');
  });

  it('при выключенном модуле orders скрыты и «Заказы», и «Промокоды»', () => {
    const owner = makeUser({ isOwner: true });
    const result = buildAdminNav(owner, modulesFromEnv({ ADMIK_MODULES: 'catalog,cdek,cms' }));
    expect(labels(result)).not.toContain('Заказы');
    expect(labels(result)).not.toContain('Промокоды');
    expect(labels(result)).toContain('Каталог');
  });

  it('пользователь только с orders.read видит «Заказы», но не «Промокоды»', () => {
    // «Промокоды» требует orders.write — read-only пользователь его не видит.
    const user = makeUser({});
    user.permissions = buildPermissionSet([{ permissions: ['orders.read'] }]);
    const result = buildAdminNav(user, modulesFromEnv({}));
    expect(labels(result)).toContain('Заказы');
    expect(labels(result)).not.toContain('Промокоды');
  });

  // Регресс: пункт меню не должен вести на несуществующий роут (404). Каждый
  // href `/admin/<seg>` обязан иметь файл-страницу app/admin/(panel)/<seg>/page.tsx
  // (для `/admin` — корневой app/admin/(panel)/page.tsx). Этот тест поймал бы
  // «Доставку» → /admin/cdek без страницы (баг 2026-06-17).
  it('каждый href меню имеет реальную страницу-роут (нет 404)', () => {
    const panelDir = join(process.cwd(), 'app', 'admin', '(panel)');
    for (const item of NAV) {
      expect(item.href.startsWith('/admin')).toBe(true);
      const seg = item.href.slice('/admin'.length).replace(/^\//, ''); // '' для /admin
      const pageFile = seg
        ? join(panelDir, seg, 'page.tsx')
        : join(panelDir, 'page.tsx');
      expect(existsSync(pageFile), `нет страницы для ${item.href} (${pageFile})`).toBe(
        true,
      );
    }
  });

  // Регресс бага #1: набор приходит из БД-оверрайда (а не из env). Меню обязано
  // реагировать на выключение модуля из UI — даже если env его включает.
  it('БД-оверрайд выключает модуль → пункт скрыт независимо от env', () => {
    const owner = makeUser({ isOwner: true });
    // env включил бы всё, но эффективный набор (env ⊕ БД) исключает catalog.
    const effective = new Set<import('@/lib/config/modules').ModuleName>([
      'orders',
      'cdek',
      'cms',
      'payments',
    ]);
    const result = buildAdminNav(owner, effective);
    expect(labels(result)).not.toContain('Каталог');
    expect(labels(result)).toContain('Заказы');
  });

  it('принимает и массив имён модулей (не только Set)', () => {
    const owner = makeUser({ isOwner: true });
    const result = buildAdminNav(owner, ['orders']);
    expect(labels(result)).toContain('Заказы');
    expect(labels(result)).not.toContain('Каталог');
    expect(labels(result)).not.toContain('Контент');
  });

  it('«Дашборд» виден всегда (нет требований по модулю/праву)', () => {
    // Пользователь без прав и без включённых модулей.
    const nobody = makeUser({});
    const noModules = buildAdminNav(nobody, modulesFromEnv({ ADMIK_MODULES: 'none' }));
    expect(labels(noModules)).toContain('Дашборд');

    // И у владельца тоже присутствует.
    const owner = makeUser({ isOwner: true });
    expect(labels(buildAdminNav(owner, modulesFromEnv({})))).toContain('Дашборд');
  });
});
