import { describe, it, expect } from 'vitest';

import { buildAdminNav, type NavItem } from '@/lib/admin/nav';
import { type AuthUser } from '@/lib/auth/rbac';
import { getEnabledModules } from '@/lib/config/modules';

/**
 * Однопользовательский режим (B9): скрытие пунктов «Пользователи» и «Роли» в меню.
 *
 * Это лишь UI-фильтр (вторая защита — guard страниц + серверная блокировка
 * мутаций). Дефолт OFF: без флага состав меню прежний.
 */
function owner(): AuthUser {
  return { id: 'u1', email: 'o@shop.io', isOwner: true, permissions: new Set() };
}
const labels = (items: NavItem[]) => items.map((i) => i.label);

describe('admin/nav — buildAdminNav singleUserMode', () => {
  it('singleUserMode=false (дефолт) → «Пользователи» и «Роли» видны', () => {
    const res = buildAdminNav(owner(), getEnabledModules({}));
    expect(labels(res)).toContain('Пользователи');
    expect(labels(res)).toContain('Роли');
  });

  it('singleUserMode=true → «Пользователи» и «Роли» скрыты', () => {
    const res = buildAdminNav(owner(), getEnabledModules({}), { singleUserMode: true });
    expect(labels(res)).not.toContain('Пользователи');
    expect(labels(res)).not.toContain('Роли');
    // Прочие core-пункты остаются (напр. Настройки, Аудит, Дашборд).
    expect(labels(res)).toContain('Настройки');
    expect(labels(res)).toContain('Дашборд');
    expect(labels(res)).toContain('Аудит');
  });
});
