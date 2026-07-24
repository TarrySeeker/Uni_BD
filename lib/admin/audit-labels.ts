/**
 * Человекочитаемые подписи для журнала аудита (находка #17).
 *
 * Раньше колонка «Действие» печатала сырой технический код (user.password.reset,
 * role.delete, auth.login_failed), а «Сущность» — голый uuid. Для нетехнического
 * владельца это нечитаемо. Здесь — чистые мапперы код→русская фраза и тип
 * сущности→русское слово (образец lib/leads/status.ts).
 *
 * Источник кодов — все `action:`/`entityType:` в Server Actions/логах аудита
 * (defineAction, writeAuditLog). При добавлении нового действия добавляйте сюда
 * подпись; неизвестный код мягко выводится как есть (фолбэк), интерфейс не падает.
 *
 * Все функции чистые и тестируемые без БД/Next.
 */

/** Код действия → русская подпись. Покрывает все коды из defineAction/аудита. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  // Аутентификация
  'auth.login': 'audit.actions.authLogin',
  'auth.login_failed': 'audit.actions.authLoginFailed',
  'auth.logout': 'audit.actions.authLogout',
  'auth.password_change': 'audit.actions.authPasswordChange',
  // Пользователи / роли
  'user.create': 'audit.actions.userCreate',
  'user.update': 'audit.actions.userUpdate',
  'user.password.reset': 'audit.actions.userPasswordReset',
  'role.create': 'audit.actions.roleCreate',
  'role.update': 'audit.actions.roleUpdate',
  'role.delete': 'audit.actions.roleDelete',
  // Каталог
  'catalog.product.create': 'audit.actions.catalogProductCreate',
  'catalog.product.update': 'audit.actions.catalogProductUpdate',
  'catalog.product.delete': 'audit.actions.catalogProductDelete',
  'catalog.product.archive': 'audit.actions.catalogProductArchive',
  'catalog.product.duplicate': 'audit.actions.catalogProductDuplicate',
  'catalog.product.bulk_status': 'audit.actions.catalogProductBulkStatus',
  'catalog.product.attributes.set': 'audit.actions.catalogProductAttributesSet',
  'catalog.variant.create': 'audit.actions.catalogVariantCreate',
  'catalog.variant.update': 'audit.actions.catalogVariantUpdate',
  'catalog.variant.delete': 'audit.actions.catalogVariantDelete',
  'catalog.category.create': 'audit.actions.catalogCategoryCreate',
  'catalog.category.update': 'audit.actions.catalogCategoryUpdate',
  'catalog.category.delete': 'audit.actions.catalogCategoryDelete',
  'catalog.category.move': 'audit.actions.catalogCategoryMove',
  'catalog.brand.create': 'audit.actions.catalogBrandCreate',
  'catalog.brand.update': 'audit.actions.catalogBrandUpdate',
  'catalog.brand.delete': 'audit.actions.catalogBrandDelete',
  'catalog.brand.logo.upload': 'audit.actions.catalogBrandLogoUpload',
  'catalog.attribute.create': 'audit.actions.catalogAttributeCreate',
  'catalog.attribute.update': 'audit.actions.catalogAttributeUpdate',
  'catalog.attribute_value.create': 'audit.actions.catalogAttributeValueCreate',
  'catalog.inventory.set': 'audit.actions.catalogInventorySet',
  'catalog.inventory.adjust': 'audit.actions.catalogInventoryAdjust',
  'catalog.media.upload': 'audit.actions.catalogMediaUpload',
  'catalog.media.delete': 'audit.actions.catalogMediaDelete',
  'catalog.media.reorder': 'audit.actions.catalogMediaReorder',
  // Заказы / промокоды
  'order.create.manual': 'audit.actions.orderCreateManual',
  'order.status.change': 'audit.actions.orderStatusChange',
  'order.payment.change': 'audit.actions.orderPaymentChange',
  'order.delivery.change': 'audit.actions.orderDeliveryChange',
  'order.cancel': 'audit.actions.orderCancel',
  'order.refund': 'audit.actions.orderRefund',
  'promo.create': 'audit.actions.promoCreate',
  'promo.update': 'audit.actions.promoUpdate',
  'promo.delete': 'audit.actions.promoDelete',
  'promo.deactivate': 'audit.actions.promoDeactivate',
  // Заявки / подписчики
  'lead.status.change': 'audit.actions.leadStatusChange',
  'lead.delete': 'audit.actions.leadDelete',
  'newsletter.unsubscribe': 'audit.actions.newsletterUnsubscribe',
  // Доставка СДЭК
  'cdek.shipment.create': 'audit.actions.cdekShipmentCreate',
  'cdek.shipment.cancel': 'audit.actions.cdekShipmentCancel',
  'cdek.status.sync': 'audit.actions.cdekStatusSync',
  'cdek.print.label': 'audit.actions.cdekPrintLabel',
  // Контент (CMS)
  'cms.page.create': 'audit.actions.cmsPageCreate',
  'cms.page.update': 'audit.actions.cmsPageUpdate',
  'cms.page.delete': 'audit.actions.cmsPageDelete',
  'cms.page.publish': 'audit.actions.cmsPagePublish',
  'cms.page.unpublish': 'audit.actions.cmsPageUnpublish',
  'cms.section.upsert': 'audit.actions.cmsSectionUpsert',
  'cms.section.delete': 'audit.actions.cmsSectionDelete',
  'cms.section.enable': 'audit.actions.cmsSectionEnable',
  'cms.section.reorder': 'audit.actions.cmsSectionReorder',
  'cms.image.upload': 'audit.actions.cmsImageUpload',
  // Настройки
  'settings.branding.update': 'audit.actions.settingsBrandingUpdate',
  'settings.catalog_orders.update': 'audit.actions.settingsCatalogOrdersUpdate',
  'settings.currency_units.update': 'audit.actions.settingsCurrencyUnitsUpdate',
  'settings.home.update': 'audit.actions.settingsHomeUpdate',
  'settings.legal_contacts.update': 'audit.actions.settingsLegalContactsUpdate',
  'settings.modules.update': 'audit.actions.settingsModulesUpdate',
  'settings.navigation.update': 'audit.actions.settingsNavigationUpdate',
  'settings.seo.update': 'audit.actions.settingsSeoUpdate',
  'settings.image.upload': 'audit.actions.settingsImageUpload',
  'settings.reset': 'audit.actions.settingsReset',
};

/** Тип сущности → русское слово (для колонки «Сущность» вместо технического). */
export const AUDIT_ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  user: 'audit.entities.user',
  role: 'audit.entities.role',
  order: 'audit.entities.order',
  product: 'audit.entities.product',
  product_variant: 'audit.entities.product_variant',
  product_media: 'audit.entities.product_media',
  category: 'audit.entities.category',
  brand: 'audit.entities.brand',
  attribute: 'audit.entities.attribute',
  attribute_value: 'audit.entities.attribute_value',
  inventory: 'audit.entities.inventory',
  promo_code: 'audit.entities.promo_code',
  lead: 'audit.entities.lead',
  newsletter_subscriber: 'audit.entities.newsletter_subscriber',
  cdek_shipment: 'audit.entities.cdek_shipment',
  cms_page: 'audit.entities.cms_page',
  cms_page_section: 'audit.entities.cms_page_section',
  cms_image: 'audit.entities.cms_image',
  shop_settings: 'audit.entities.shop_settings',
};

/** Подпись действия (фолбэк — сам код, если он неизвестен — интерфейс не падает). */
export function auditActionLabel(
  code: string,
  t: (key: string) => string,
): string {
  const key = AUDIT_ACTION_LABELS[code];
  return key ? t(key) : code;
}

/** Подпись типа сущности (фолбэк — сам тип, если он неизвестен). */
export function auditEntityTypeLabel(
  type: string,
  t: (key: string) => string,
): string {
  const key = AUDIT_ENTITY_TYPE_LABELS[type];
  return key ? t(key) : type;
}
