import { describe, it, expect } from 'vitest';

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
  auditActionLabel,
  auditEntityTypeLabel,
} from '@/lib/admin/audit-labels';

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
      expect(AUDIT_ACTION_LABELS[code], `нет подписи для ${code}`).toBeTruthy();
      expect(auditActionLabel(code)).not.toBe(code);
    }
  });

  it('у каждого реального типа сущности есть русская подпись', () => {
    for (const type of KNOWN_ENTITY_TYPES) {
      expect(AUDIT_ENTITY_TYPE_LABELS[type], `нет подписи для ${type}`).toBeTruthy();
      expect(auditEntityTypeLabel(type)).not.toBe(type);
    }
  });

  it('конкретные подписи читаемы (примеры из находки)', () => {
    expect(auditActionLabel('user.password.reset')).toBe('Сброс пароля пользователя');
    expect(auditActionLabel('role.delete')).toBe('Удаление роли');
    expect(auditActionLabel('auth.login_failed')).toBe('Неудачная попытка входа');
    expect(auditEntityTypeLabel('user')).toBe('Пользователь');
    expect(auditEntityTypeLabel('role')).toBe('Роль');
  });

  it('неизвестный код/тип мягко возвращается как есть (фолбэк, без падения)', () => {
    expect(auditActionLabel('some.future.action')).toBe('some.future.action');
    expect(auditEntityTypeLabel('future_entity')).toBe('future_entity');
    expect(auditActionLabel('')).toBe('');
  });
});
