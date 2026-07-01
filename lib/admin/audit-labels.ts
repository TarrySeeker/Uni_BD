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
  'auth.login': 'Вход в систему',
  'auth.login_failed': 'Неудачная попытка входа',
  'auth.logout': 'Выход из системы',
  'auth.password_change': 'Смена своего пароля',
  // Пользователи / роли
  'user.create': 'Создание пользователя',
  'user.update': 'Изменение пользователя',
  'user.password.reset': 'Сброс пароля пользователя',
  'role.create': 'Создание роли',
  'role.update': 'Изменение роли',
  'role.delete': 'Удаление роли',
  // Каталог
  'catalog.product.create': 'Создание товара',
  'catalog.product.update': 'Изменение товара',
  'catalog.product.delete': 'Удаление товара',
  'catalog.product.archive': 'Архивирование товара',
  'catalog.product.duplicate': 'Дублирование товара',
  'catalog.product.bulk_status': 'Массовая смена статуса товаров',
  'catalog.product.attributes.set': 'Изменение атрибутов товара',
  'catalog.variant.create': 'Создание варианта',
  'catalog.variant.update': 'Изменение варианта',
  'catalog.variant.delete': 'Удаление варианта',
  'catalog.category.create': 'Создание категории',
  'catalog.category.update': 'Изменение категории',
  'catalog.category.delete': 'Удаление категории',
  'catalog.category.move': 'Перемещение категории',
  'catalog.brand.create': 'Создание бренда',
  'catalog.brand.update': 'Изменение бренда',
  'catalog.brand.delete': 'Удаление бренда',
  'catalog.brand.logo.upload': 'Загрузка логотипа бренда',
  'catalog.attribute.create': 'Создание атрибута',
  'catalog.attribute.update': 'Изменение атрибута',
  'catalog.attribute_value.create': 'Создание значения атрибута',
  'catalog.inventory.set': 'Установка остатка',
  'catalog.inventory.adjust': 'Корректировка остатка',
  'catalog.media.upload': 'Загрузка медиа',
  'catalog.media.delete': 'Удаление медиа',
  'catalog.media.reorder': 'Сортировка медиа',
  // Заказы / промокоды
  'order.create.manual': 'Создание заказа вручную',
  'order.status.change': 'Смена статуса заказа',
  'order.payment.change': 'Смена статуса оплаты',
  'order.delivery.change': 'Смена статуса доставки',
  'order.cancel': 'Отмена заказа',
  'order.refund': 'Возврат по заказу',
  'promo.create': 'Создание промокода',
  'promo.update': 'Изменение промокода',
  'promo.delete': 'Удаление промокода',
  'promo.deactivate': 'Деактивация промокода',
  // Заявки / подписчики
  'lead.status.change': 'Смена статуса заявки',
  'lead.delete': 'Удаление заявки',
  'newsletter.unsubscribe': 'Отписка подписчика',
  // Доставка СДЭК
  'cdek.shipment.create': 'Создание отправления СДЭК',
  'cdek.shipment.cancel': 'Отмена отправления СДЭК',
  'cdek.status.sync': 'Синхронизация статуса СДЭК',
  'cdek.print.label': 'Печать накладной СДЭК',
  // Контент (CMS)
  'cms.page.create': 'Создание страницы',
  'cms.page.update': 'Изменение страницы',
  'cms.page.delete': 'Удаление страницы',
  'cms.page.publish': 'Публикация страницы',
  'cms.page.unpublish': 'Снятие страницы с публикации',
  'cms.section.upsert': 'Сохранение секции',
  'cms.section.delete': 'Удаление секции',
  'cms.section.enable': 'Включение/выключение секции',
  'cms.section.reorder': 'Сортировка секций',
  'cms.image.upload': 'Загрузка изображения (контент)',
  // Настройки
  'settings.branding.update': 'Изменение брендинга',
  'settings.catalog_orders.update': 'Настройки каталога и заказов',
  'settings.currency_units.update': 'Настройки валюты и единиц',
  'settings.home.update': 'Изменение главной страницы',
  'settings.legal_contacts.update': 'Изменение юр. данных и контактов',
  'settings.modules.update': 'Изменение состава модулей',
  'settings.navigation.update': 'Изменение навигации',
  'settings.seo.update': 'Изменение SEO',
  'settings.image.upload': 'Загрузка изображения (настройки)',
  'settings.reset': 'Сброс настроек',
};

/** Тип сущности → русское слово (для колонки «Сущность» вместо технического). */
export const AUDIT_ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  user: 'Пользователь',
  role: 'Роль',
  order: 'Заказ',
  product: 'Товар',
  product_variant: 'Вариант',
  product_media: 'Медиа товара',
  category: 'Категория',
  brand: 'Бренд',
  attribute: 'Атрибут',
  attribute_value: 'Значение атрибута',
  inventory: 'Остаток',
  promo_code: 'Промокод',
  lead: 'Заявка',
  newsletter_subscriber: 'Подписчик',
  cdek_shipment: 'Отправление СДЭК',
  cms_page: 'Страница',
  cms_page_section: 'Секция страницы',
  cms_image: 'Изображение (контент)',
  shop_settings: 'Настройки магазина',
};

/** Подпись действия (фолбэк — сам код, если он неизвестен — интерфейс не падает). */
export function auditActionLabel(code: string): string {
  return AUDIT_ACTION_LABELS[code] ?? code;
}

/** Подпись типа сущности (фолбэк — сам тип, если он неизвестен). */
export function auditEntityTypeLabel(type: string): string {
  return AUDIT_ENTITY_TYPE_LABELS[type] ?? type;
}
