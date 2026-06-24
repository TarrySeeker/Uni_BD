-- =============================================================================
-- db/seed/roles.sql
-- -----------------------------------------------------------------------------
-- Этап 1, задача 1.7 — seed системных ролей и привязки прав (docs/04 §4.2, §5.2).
--
-- Источник данных — lib/auth/permissions.ts (SYSTEM_ROLES). Должно держаться в
-- синхроне с ним (контракт проверяется в tests/seed/seed.test.ts).
--
-- Системные роли (is_system = true, неудаляемы, code неизменяем):
--   * owner   — пользователь-владелец (is_owner). Явных прав НЕТ: проверка
--               короткозамкнута в can() (§5.4), роль — лишь маркер для seed/UI.
--   * admin   — все права (core/catalog/orders/cms/cdek).
--   * manager — операционный набор: orders.read/write, catalog.read,
--               cdek.manage, audit.read.
--
-- ВАЖНО про порядок: этот файл накатывается ПОСЛЕ permissions.sql, т.к.
-- role_permissions ссылается на permissions(code) (FK) и берёт коды подзапросом.
--
-- Идемпотентно: ON CONFLICT DO NOTHING на всех INSERT (роли — по code через
-- уникальный индекс roles_code_uniq; привязки — по PK (role_id, permission_code)).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Системные роли. ON CONFLICT (code) опирается на UNIQUE INDEX roles_code_uniq.
-- -----------------------------------------------------------------------------
INSERT INTO roles (code, title, is_system) VALUES
  ('owner',   'Владелец',       true),
  ('admin',   'Администратор',  true),
  ('manager', 'Менеджер',       true)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Привязки прав admin: все права из ALL_PERMISSIONS. role_id берём подзапросом
-- по коду роли, permission_code — из таблицы permissions (источник истины).
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'admin'
  AND p.code IN (
    'users.read',
    'users.manage',
    'roles.manage',
    'audit.read',
    'settings.manage',
    'catalog.read',
    'catalog.write',
    'orders.read',
    'orders.write',
    'cdek.manage',
    'cms.read',
    'cms.write'
  )
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Привязки прав manager: операционный набор (§5.2).
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'manager'
  AND p.code IN (
    'orders.read',
    'orders.write',
    'catalog.read',
    'cdek.manage',
    'audit.read'
  )
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- owner: без явных привязок прав — короткое замыкание is_owner (§5.4).
