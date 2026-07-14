import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_MODULES, type ModuleName } from '@/lib/config/modules';
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  type PermissionCode,
} from '@/lib/auth/permissions';
import { NAV } from '@/lib/admin/nav';

/**
 * Тест полноты регистрации ядра (критик #13).
 *
 * Инварианты «чек-листа регистрации» (union → ALL_* → SYSTEM_ROLES → NAV):
 *   1. У каждого право-код валидный module ('core' либо реальный ModuleName).
 *   2. Каждый новый функциональный модуль (news/reviews/account) имеет ≥1 право.
 *   3. Нет сирот-прав: каждый код из ALL_PERMISSIONS назначен ≥1 системной роли
 *      (гарантируется инвариантом «admin держит весь ALL_PERMISSIONS»).
 *   4. Права ролей ссылаются только на существующие коды.
 *   5. NAV не даёт битых ссылок: пункт с module → module ∈ ALL_MODULES и имеет
 *      реальную страницу; модули без admin-страницы (news/reviews/account) в NAV
 *      отсутствуют (их пункты добавит шаг соответствующей фичи).
 */

const ALL_CODES = new Set<PermissionCode>(ALL_PERMISSIONS.map((p) => p.code));
const MODULE_SET = new Set<ModuleName>(ALL_MODULES);

const panelDir = join(process.cwd(), 'app', 'admin', '(panel)');
function modulePageExists(mod: ModuleName): boolean {
  // Эвристика: у модуля есть страница, если существует любой NAV.href этого
  // модуля с файлом-страницей. Здесь проверяем напрямую по каноничному сегменту.
  return existsSync(join(panelDir, mod, 'page.tsx'));
}

describe('регистрация ядра — полнота (критик #13)', () => {
  it('module каждого права — core или реальный ModuleName', () => {
    for (const perm of ALL_PERMISSIONS) {
      const ok = perm.module === 'core' || MODULE_SET.has(perm.module);
      expect(ok, `право ${perm.code} ссылается на неизвестный модуль ${perm.module}`).toBe(
        true,
      );
    }
  });

  it('новые модули news/reviews/account зарегистрированы и имеют права', () => {
    for (const mod of ['news', 'reviews', 'account'] as const) {
      expect(MODULE_SET.has(mod), `модуль ${mod} не в ALL_MODULES`).toBe(true);
      const perms = ALL_PERMISSIONS.filter((p) => p.module === mod);
      expect(perms.length, `у модуля ${mod} нет прав`).toBeGreaterThan(0);
    }
  });

  it('admin держит ВЕСЬ ALL_PERMISSIONS (нет прав-сирот без роли)', () => {
    const admin = SYSTEM_ROLES.find((r) => r.code === 'admin');
    expect(admin).toBeDefined();
    const adminSet = new Set(admin!.permissions);
    for (const code of ALL_CODES) {
      expect(adminSet.has(code), `право ${code} не назначено роли admin (сирота)`).toBe(
        true,
      );
    }
  });

  it('каждое право назначено хотя бы одной системной роли (owner исключён)', () => {
    const assigned = new Set<PermissionCode>();
    for (const role of SYSTEM_ROLES) {
      for (const code of role.permissions) assigned.add(code);
    }
    for (const code of ALL_CODES) {
      expect(assigned.has(code), `право ${code} не назначено ни одной роли`).toBe(true);
    }
  });

  it('права системных ролей ссылаются только на существующие коды', () => {
    for (const role of SYSTEM_ROLES) {
      for (const code of role.permissions) {
        expect(ALL_CODES.has(code), `роль ${role.code}: неизвестный код ${code}`).toBe(
          true,
        );
      }
    }
  });

  it('manager получил reviews.read/write и customers.read', () => {
    const manager = SYSTEM_ROLES.find((r) => r.code === 'manager');
    const set = new Set(manager!.permissions);
    for (const code of ['reviews.read', 'reviews.write', 'customers.read'] as const) {
      expect(set.has(code), `manager не имеет ${code}`).toBe(true);
    }
    // manager не должен получить полномочия записи покупателей.
    expect(set.has('customers.write')).toBe(false);
  });

  it('owner — маркер без явных прав (короткое замыкание is_owner)', () => {
    const owner = SYSTEM_ROLES.find((r) => r.code === 'owner');
    expect(owner!.permissions).toEqual([]);
  });

  it('NAV: каждый модульный пункт → валидный ModuleName с реальной страницей', () => {
    for (const item of NAV) {
      if (!item.module) continue;
      expect(MODULE_SET.has(item.module), `NAV ${item.href}: модуль ${item.module} неизвестен`).toBe(
        true,
      );
      const seg = item.href.slice('/admin'.length).replace(/^\//, '');
      const pageFile = seg ? join(panelDir, seg, 'page.tsx') : join(panelDir, 'page.tsx');
      expect(existsSync(pageFile), `NAV ${item.href}: нет страницы (битая ссылка)`).toBe(
        true,
      );
    }
  });

  it('модули без admin-страницы (news/reviews/account) отсутствуют в NAV', () => {
    for (const mod of ['news', 'reviews', 'account'] as const) {
      // Пока страницы фичи нет — NAV не должен на модуль ссылаться (иначе 404).
      if (!modulePageExists(mod)) {
        const leaks = NAV.filter((i) => i.module === mod).map((i) => i.href);
        expect(leaks, `NAV ссылается на модуль ${mod} без страницы: ${leaks.join(',')}`).toEqual(
          [],
        );
      }
    }
  });
});
