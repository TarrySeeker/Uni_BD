import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
  auditActionLabel,
  auditEntityTypeLabel,
} from '@/lib/admin/audit-labels';

// После i18n-переноса (волна 6-Б) значения мап — i18n-КЛЮЧИ; сами русские подписи
// живут в messages/ru.json. label-функции принимают переводчик `t`. Здесь строим
// `t` из ru.json — так инвариант (у каждого кода есть читаемая русская подпись)
// сохранён, просто текст «переехал» в каталог.
const ru = JSON.parse(
  readFileSync(resolve(__dirname, '../../messages/ru.json'), 'utf8'),
) as Record<string, unknown>;
function ruGet(key: string): string | undefined {
  let o: unknown = ru;
  for (const k of key.split('.'))
    o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return typeof o === 'string' ? o : undefined;
}
const t = (key: string): string => ruGet(key) ?? key;

/**
 * Находка #17: журнал аудита показывал сырые коды действий и типы сущностей.
 * Проверяем чистые мапперы код→русская фраза. Списки KNOWN_* отражают все
 * action:/entityType:, реально пишущиеся в audit_log (см. grep по defineAction):
 * если кто-то заведёт новый код и забудет подпись — этот тест упадёт (guard).
 */

// Полный набор кодов действий, реально пишущихся в аудит (grep action:).
const KNOWN_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_change',
  'user.create',
  'user.update',
  'user.password.reset',
  'role.create',
  'role.update',
  'role.delete',
  'catalog.product.create',
  'catalog.product.update',
  'catalog.product.delete',
  'catalog.product.archive',
  'catalog.product.duplicate',
  'catalog.product.bulk_status',
  'catalog.product.attributes.set',
  'catalog.variant.create',
  'catalog.variant.update',
  'catalog.variant.delete',
  'catalog.category.create',
  'catalog.category.update',
  'catalog.category.delete',
  'catalog.category.move',
  'catalog.brand.create',
  'catalog.brand.update',
  'catalog.brand.delete',
  'catalog.brand.logo.upload',
  'catalog.attribute.create',
  'catalog.attribute.update',
  'catalog.attribute_value.create',
  'catalog.inventory.set',
  'catalog.inventory.adjust',
  'catalog.media.upload',
  'catalog.media.delete',
  'catalog.media.reorder',
  'order.create.manual',
  'order.status.change',
  'order.payment.change',
  'order.delivery.change',
  'order.cancel',
  'order.refund',
  'promo.create',
  'promo.update',
  'promo.delete',
  'promo.deactivate',
  'lead.status.change',
  'lead.delete',
  'newsletter.unsubscribe',
  'cdek.shipment.create',
  'cdek.shipment.cancel',
  'cdek.status.sync',
  'cdek.print.label',
  'cms.page.create',
  'cms.page.update',
  'cms.page.delete',
  'cms.page.publish',
  'cms.page.unpublish',
  'cms.section.upsert',
  'cms.section.delete',
  'cms.section.enable',
  'cms.section.reorder',
  'cms.image.upload',
  'settings.branding.update',
  'settings.catalog_orders.update',
  'settings.currency_units.update',
  'settings.home.update',
  'settings.legal_contacts.update',
  'settings.modules.update',
  'settings.navigation.update',
  'settings.seo.update',
  'settings.image.upload',
  'settings.reset',
] as const;

// Полный набор типов сущностей (grep entityType:).
const KNOWN_ENTITY_TYPES = [
  'attribute',
  'attribute_value',
  'brand',
  'category',
  'cdek_shipment',
  'cms_image',
  'cms_page',
  'cms_page_section',
  'inventory',
  'lead',
  'newsletter_subscriber',
  'order',
  'product',
  'product_media',
  'product_variant',
  'promo_code',
  'role',
  'shop_settings',
  'user',
] as const;

describe('подписи журнала аудита', () => {
  it('у каждого реального кода действия есть русская подпись (не равная коду)', () => {
    for (const code of KNOWN_ACTIONS) {
      const key = AUDIT_ACTION_LABELS[code];
      expect(key, `нет ключа подписи для ${code}`).toBeTruthy();
      expect(ruGet(key!), `ключ ${key} отсутствует в ru.json`).toBeTruthy();
      expect(auditActionLabel(code, t)).not.toBe(code);
    }
  });

  it('у каждого реального типа сущности есть русская подпись', () => {
    for (const type of KNOWN_ENTITY_TYPES) {
      const key = AUDIT_ENTITY_TYPE_LABELS[type];
      expect(key, `нет ключа подписи для ${type}`).toBeTruthy();
      expect(ruGet(key!), `ключ ${key} отсутствует в ru.json`).toBeTruthy();
      expect(auditEntityTypeLabel(type, t)).not.toBe(type);
    }
  });

  it('конкретные подписи читаемы (примеры из находки)', () => {
    expect(auditActionLabel('user.password.reset', t)).toBe('Сброс пароля пользователя');
    expect(auditActionLabel('role.delete', t)).toBe('Удаление роли');
    expect(auditActionLabel('auth.login_failed', t)).toBe('Неудачная попытка входа');
    expect(auditEntityTypeLabel('user', t)).toBe('Пользователь');
    expect(auditEntityTypeLabel('role', t)).toBe('Роль');
  });

  it('неизвестный код/тип мягко возвращается как есть (фолбэк, без падения)', () => {
    expect(auditActionLabel('some.future.action', t)).toBe('some.future.action');
    expect(auditEntityTypeLabel('future_entity', t)).toBe('future_entity');
    expect(auditActionLabel('', t)).toBe('');
  });
});
