/**
 * Zod-схемы значений `shop_settings.value` по ключам (docs/11 §5.4.1).
 *
 * Одна строка таблицы = одна логическая группа настроек (НЕ плоский blob и НЕ
 * таблица-на-ключ). `value` каждого ключа типизирован своей схемой; неизвестные
 * поля ОТБРАСЫВАЮТСЯ Zod (по умолчанию `.strip()`) — анти-tamper для JSONB.
 *
 * Семантика merge (§7 инвариант): env-дефолт ⊕ строка БД, частичный merge на
 * уровне полей. Пустой объект `{}` = «нет оверрайда» → берётся env. Деньги в
 * `value` (delivery.freeDeliveryThreshold) — в КОПЕЙКАХ (int), без float.
 *
 * Экспортируется как ОБЫЧНЫЙ модуль (не 'use server') — содержит схемы/типы,
 * переиспользуемые и слоем настроек, и Server Actions, и UI-формами.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** Непустая строка с тримом. */
const nonEmpty = z.string().trim().min(1);

/** Опциональный URL (пустая строка не допускается — поле либо есть, либо нет). */
const urlField = z.string().trim().url();

/** HEX-цвет вида #rgb / #rrggbb (для темы брендинга). */
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Ожидается HEX-цвет (#rgb или #rrggbb)');

/** ISO 4217 — буквенный код валюты (3 заглавные латинские). */
const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Код валюты — 3 заглавные латинские буквы (ISO 4217)');

/** ИНН: ровно 10 (юрлицо) или 12 (ИП/физлицо) цифр. */
const innField = z
  .string()
  .trim()
  .regex(/^(?:\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр');

/** Денежная величина в копейках (целое, ≥ 0). */
const minorMoney = z.number().int().min(0);

// -----------------------------------------------------------------------------
// Схемы значений по ключам (§5.4.1). Все объекты — `partial`/опциональные поля,
// т.к. строка БД хранит ТОЛЬКО оверрайды; отсутствующее поле → env-дефолт.
// -----------------------------------------------------------------------------

/** branding — название/логотип/тема/контакты поддержки. */
export const brandingSchema = z
  .object({
    shopName: nonEmpty.optional(),
    logoUrl: urlField.optional(),
    faviconUrl: urlField.optional(),
    theme: z
      .object({
        primaryColor: hexColor.optional(),
        accentColor: hexColor.optional(),
        mode: z.enum(['light', 'dark', 'system']).optional(),
      })
      .optional(),
    supportEmail: z.string().trim().email().optional(),
    supportPhone: z.string().trim().min(1).optional(),
  })
  .strip();

/** currency — валюта магазина. */
export const currencySchema = z
  .object({
    code: currencyCode.optional(),
    symbol: z.string().trim().min(1).optional(),
    locale: z.string().trim().min(1).optional(),
    fractionDigits: z.number().int().min(0).max(4).optional(),
  })
  .strip();

/** units — единицы измерения веса/габаритов. */
export const unitsSchema = z
  .object({
    weight: z.enum(['g', 'kg']).optional(),
    dimension: z.enum(['cm', 'mm']).optional(),
    system: z.literal('metric').optional(),
  })
  .strip();

/** contacts — публичные контакты магазина. */
export const contactsSchema = z
  .object({
    phone: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    address: z.string().trim().min(1).optional(),
    workingHours: z.string().trim().min(1).optional(),
    socials: z
      .array(
        z.object({
          type: nonEmpty,
          url: urlField,
        }),
      )
      .optional(),
  })
  .strip();

/** legal_entity — реквизиты юрлица (приватные: bankDetails наружу не отдаём). */
export const legalEntitySchema = z
  .object({
    name: nonEmpty.optional(),
    inn: innField.optional(),
    kpp: z
      .string()
      .trim()
      .regex(/^\d{9}$/, 'КПП — 9 цифр')
      .optional(),
    ogrn: z
      .string()
      .trim()
      .regex(/^(?:\d{13}|\d{15})$/, 'ОГРН — 13 или 15 цифр')
      .optional(),
    legalAddress: z.string().trim().min(1).optional(),
    bankDetails: z.string().trim().min(1).optional(),
  })
  .strip();

/** catalog — оверрайд SHOP_NEW_PRODUCT_DAYS. */
export const catalogSettingsSchema = z
  .object({
    newProductDays: z.number().int().min(0).optional(),
  })
  .strip();

/** delivery — оверрайд SHOP_FREE_DELIVERY_THRESHOLD (в КОПЕЙКАХ). */
export const deliverySettingsSchema = z
  .object({
    freeDeliveryThreshold: minorMoney.optional(),
  })
  .strip();

/** orders — оверрайд SHOP_ORDER_PREFIX. */
export const ordersSettingsSchema = z
  .object({
    orderPrefix: z.string().trim().optional(),
  })
  .strip();

/**
 * module_overrides — частичный оверрайд ADMIK_MODULES.
 * Отсутствие поля → берётся env-набор (getEnabledModules); явный true/false —
 * включает/выключает соответствующий модуль поверх env. `settings` НЕ входит в
 * схему (core-always-on — не может прятаться за флагом, который сам переключает).
 */
export const moduleOverridesSchema = z
  .object({
    catalog: z.boolean().optional(),
    orders: z.boolean().optional(),
    cdek: z.boolean().optional(),
    cms: z.boolean().optional(),
    payments: z.boolean().optional(),
  })
  .strip();

/** seo — дефолты SEO/sitemap/robots (используется подсистемой 5.3). */
export const seoSettingsSchema = z
  .object({
    site_name: z.string().trim().min(1).optional(),
    site_url: urlField.optional(),
    title_template: z.string().trim().min(1).optional(),
    default_description: z.string().trim().optional(),
    default_og_image_key: z.string().trim().optional(),
    robots_extra: z.string().trim().optional(),
    twitter_site: z.string().trim().optional(),
    noindex_site: z.boolean().optional(),
  })
  .strip();

/**
 * home — редактируемый контент главной страницы витрины (ADR-018).
 *
 * Именованные блоки (hero/about/quality/delivery); все поля опциональны и
 * `.strip()` (анти-tamper JSONB). Изображения хранятся КЛЮЧАМИ S3 (imageKey/
 * imageKeys), не URL — единый контракт с CMS (ADR-012); витрина резолвит ключ в
 * URL на своей стороне. Семантика merge (§5.4.1): строка БД хранит оверрайд
 * блока ЦЕЛИКОМ; отсутствие блока → дефолт витрины (lib/config/home-defaults).
 */
export const homeSchema = z
  .object({
    hero: z
      .object({
        title: z.string().trim().min(1).optional(),
        subtitle: z.string().trim().min(1).optional(),
        imageKey: z.string().trim().min(1).optional(),
        ctaLabel: z.string().trim().min(1).optional(),
        ctaHref: z.string().trim().min(1).optional(),
      })
      .strip()
      .optional(),
    about: z
      .object({
        title: z.string().trim().min(1).optional(),
        paragraphs: z.array(z.string().trim().min(1)).optional(),
        imageKeys: z.array(z.string().trim().min(1)).optional(),
        values: z.array(z.string().trim().min(1)).optional(),
      })
      .strip()
      .optional(),
    quality: z
      .object({
        title: z.string().trim().min(1).optional(),
        items: z.array(z.string().trim().min(1)).optional(),
      })
      .strip()
      .optional(),
    delivery: z
      .object({
        items: z
          .array(
            z
              .object({
                title: nonEmpty,
                text: nonEmpty,
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

// -----------------------------------------------------------------------------
/**
 * navigation — меню шапки и колонки футера витрины (G-10/G-11). Все элементы
 * опциональны; пусто → витрина показывает навигацию по умолчанию. Позволяет
 * переименовать/добавить пункты меню и ссылки футера без правки кода (мультитенант).
 */
const navLinkSchema = z.object({ label: nonEmpty, href: nonEmpty }).strip();

export const navigationSchema = z
  .object({
    header: z.array(navLinkSchema).optional(),
    footer: z
      .array(
        z
          .object({
            title: nonEmpty,
            links: z.array(navLinkSchema),
          })
          .strip(),
      )
      .optional(),
  })
  .strip();

// -----------------------------------------------------------------------------
// Реестр ключ → схема. Единственный источник правды о наборе ключей настроек.
// -----------------------------------------------------------------------------

/** Стабильные ключи логических разделов настроек (PK shop_settings.setting_key). */
export const SETTING_KEYS = [
  'branding',
  'currency',
  'units',
  'contacts',
  'legal_entity',
  'catalog',
  'delivery',
  'orders',
  'module_overrides',
  'seo',
  'home',
  'navigation',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Карта ключ → Zod-схема значения. */
export const SETTING_SCHEMAS = {
  branding: brandingSchema,
  currency: currencySchema,
  units: unitsSchema,
  contacts: contactsSchema,
  legal_entity: legalEntitySchema,
  catalog: catalogSettingsSchema,
  delivery: deliverySettingsSchema,
  orders: ordersSettingsSchema,
  module_overrides: moduleOverridesSchema,
  seo: seoSettingsSchema,
  home: homeSchema,
  navigation: navigationSchema,
} as const satisfies Record<SettingKey, z.ZodTypeAny>;

// Типы значений по ключам (выводятся из схем).
export type BrandingSettings = z.infer<typeof brandingSchema>;
export type CurrencySettings = z.infer<typeof currencySchema>;
export type UnitsSettings = z.infer<typeof unitsSchema>;
export type ContactsSettings = z.infer<typeof contactsSchema>;
export type LegalEntitySettings = z.infer<typeof legalEntitySchema>;
export type CatalogSettings = z.infer<typeof catalogSettingsSchema>;
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export type OrdersSettings = z.infer<typeof ordersSettingsSchema>;
export type ModuleOverrides = z.infer<typeof moduleOverridesSchema>;
export type SeoSettings = z.infer<typeof seoSettingsSchema>;
export type HomeSettings = z.infer<typeof homeSchema>;
export type NavigationSettings = z.infer<typeof navigationSchema>;

/**
 * Безопасный парс значения по ключу. Возвращает провалидированный частичный
 * объект либо `null`, если value не проходит схему ключа (раздел игнорируется,
 * остаётся env-дефолт — merge не должен падать на одной кривой строке БД).
 */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): z.infer<(typeof SETTING_SCHEMAS)[K]> | null {
  const schema = SETTING_SCHEMAS[key];
  const parsed = schema.safeParse(value ?? {});
  return parsed.success ? (parsed.data as z.infer<(typeof SETTING_SCHEMAS)[K]>) : null;
}

/** Проверка, что строка — известный ключ настроек. */
export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}
