/**
 * Фабрика Server Actions настроек магазина (docs/11 §5.4.3, ADR-013).
 *
 * Вынесена из lib/settings/actions.ts ('use server'), т.к. такой модуль может
 * экспортировать ТОЛЬКО async-функции, а здесь живут: фабрика createSettingsActions
 * (синхронная, возвращает объект действий), входные Zod-схемы, типы зависимостей и
 * дефолтные data-чекеры. actions.ts тонко оборачивает прод-экземпляр.
 *
 * Все мутации — через единый пайплайн defineAction({permission:'settings.manage'}):
 * guard → Zod → handler (upsert/delete shop_settings) → revalidate → audit.
 * После КАЖДОЙ мутации вызывается invalidateCache() (read-your-own-writes).
 *
 * Деньги: freeDeliveryThreshold вводится в РУБЛЯХ (money-строка) → хранится в
 * КОПЕЙКАХ (int) через toMinor — новый JSONB-слой delivery.value (копейки).
 *
 * ТЕСТИРУЕМОСТЬ без БД/Next (ADR-004): createSettingsActions(deps) инъецирует
 * репозиторий/инвалидацию кеша/data-чекеры и ActionDeps.
 */

import { z } from 'zod';

import {
  defineAction,
  defaultDeps,
  PublicActionError,
  type ActionDeps,
  type ActionCtx,
} from '@/lib/server/action';
import { sql } from '@/lib/db/client';
import { ALL_MODULES } from '@/lib/config/modules';
import { toMinor } from '@/lib/orders/money';
import {
  brandingSchema,
  currencySchema,
  unitsSchema,
  contactsSchema,
  legalEntitySchema,
  catalogSettingsSchema,
  ordersSettingsSchema,
  seoSettingsSchema,
  homeSchema,
  navigationSchema,
  SETTING_KEYS,
} from '@/lib/settings/schemas';
import {
  upsertSetting as dbUpsertSetting,
  deleteSetting as dbDeleteSetting,
  getSetting as dbGetSetting,
  type ShopSettingRow,
} from '@/lib/settings/repository';
import { invalidateSettingsCache } from '@/lib/config/settings';
import { getStorage as defaultGetStorage } from '@/lib/storage';
import { validateUpload as defaultValidateUpload } from '@/lib/storage/validate';
import { generatePreviews as defaultGeneratePreviews } from '@/lib/storage/image';
import type { ObjectStorage } from '@/lib/storage';
import type { MediaValidationResult } from '@/lib/storage/validate';
import type { PreviewSet } from '@/lib/storage/image';

// =============================================================================
// Входные схемы действий (композиция value-схем ключей).
// =============================================================================

/** Денежная величина в РУБЛЯХ (money-строка/число) — для ввода порога доставки. */
const moneyRubles = z
  .union([z.string(), z.number()])
  .refine((v) => {
    try {
      toMinor(v as string | number);
      return true;
    } catch {
      return false;
    }
  }, 'Ожидается неотрицательная сумма в рублях (до 2 знаков после точки)');

/** delivery на ВХОДЕ: порог в рублях (конвертируется в копейки в handler). */
const deliveryInputSchema = z
  .object({ freeDeliveryThreshold: moneyRubles.optional() })
  .strip();

export const BrandingInputSchema = z.object({ branding: brandingSchema });
export const CurrencyUnitsInputSchema = z.object({
  currency: currencySchema.optional(),
  units: unitsSchema.optional(),
});
export const LegalContactsInputSchema = z.object({
  legalEntity: legalEntitySchema.optional(),
  contacts: contactsSchema.optional(),
});
export const CatalogOrdersInputSchema = z.object({
  catalog: catalogSettingsSchema.optional(),
  delivery: deliveryInputSchema.optional(),
  orders: ordersSettingsSchema.optional(),
});
/**
 * module_overrides на ВХОДЕ действия — `.strict()`: неизвестный модуль (опечатка
 * или попытка переключить core, напр. `settings`) → validation-ошибка, а не тихий
 * `.strip()`. Merge-слой (lib/config/settings) использует мягкий `.strip()` для
 * толерантности к строкам БД; UI-ввод обязан быть точным.
 *
 * Набор переключаемых ключей выводится из ALL_MODULES (lib/config/modules) —
 * единственного источника правды о составе модулей платформы. Это исключает
 * рассинхрон input-схемы с ALL_MODULES/moduleOverridesSchema (раньше отсутствовал
 * `payments` → его нельзя было включить/выключить через action).
 */
const moduleOverridesShape = Object.fromEntries(
  ALL_MODULES.map((m) => [m, z.boolean().optional()]),
) as Record<(typeof ALL_MODULES)[number], z.ZodOptional<z.ZodBoolean>>;

export const ModuleOverridesInputSchema = z.object({
  moduleOverrides: z.object(moduleOverridesShape).strict(),
});
/** reset: ключ обязан быть известным разделом настроек (иначе validation). */
export const ResetSettingInputSchema = z.object({
  key: z.enum(SETTING_KEYS),
});

/**
 * seo на ВХОДЕ действия (docs/11 §5.3.3): базовая seoSettingsSchema +
 * дополнительная проверка `title_template` обязан содержать '%s' (плейсхолдер
 * заголовка). Без '%s' заголовки сущностей подставлять некуда → validation.
 * site_url валидируется как url-или-отсутствует уже в seoSettingsSchema.
 */
/** home на ВХОДЕ действия — value-схема homeSchema целиком (опц. блоки, .strip()). */
export const HomeInputSchema = z.object({ home: homeSchema });

/** navigation на ВХОДЕ действия (G-10/G-11): меню шапки + колонки футера. */
export const NavigationInputSchema = z.object({ navigation: navigationSchema });

/**
 * Вход загрузки изображения настроек: kind (logo|favicon|og) + байты файла.
 * Байты извлекаются из FormData в обёртке (Server Action принимает FormData);
 * тип/размер реально проверяются validateUpload по magic-bytes (как у бренда).
 */
export const SETTINGS_IMAGE_KINDS = ['logo', 'favicon', 'og'] as const;
export type SettingsImageKind = (typeof SETTINGS_IMAGE_KINDS)[number];
export const SettingsImageUploadSchema = z.object({
  kind: z.enum(SETTINGS_IMAGE_KINDS),
  filename: z.string().max(255).optional().default('upload'),
  bytes: z.instanceof(Buffer),
});

export const SeoSettingsInputSchema = z.object({
  seo: seoSettingsSchema.superRefine((value, ctx) => {
    if (value.title_template !== undefined && !value.title_template.includes('%s')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "title_template должен содержать плейсхолдер «%s»",
        path: ['title_template'],
      });
    }
  }),
});

// =============================================================================
// Зависимости фабрики (инъекция для тестов без БД).
// =============================================================================

/** Результат updateModuleOverrides: warnings — мягкие предупреждения (не блок). */
export interface ModuleOverridesResult {
  warnings: string[];
}

/** Зависимости settings-actions. */
export interface SettingsActionDeps {
  /** Зависимости пайплайна defineAction (user/audit/revalidate/meta). */
  actionDeps: ActionDeps;
  /** UPSERT строки настроек. */
  upsertSetting: (
    key: string,
    value: Record<string, unknown>,
    updatedBy: string | null,
  ) => Promise<ShopSettingRow>;
  /** DELETE строки настроек (reset к env-дефолту). */
  deleteSetting: (key: string) => Promise<boolean>;
  /** Чтение строки (before-снимок для audit). */
  getSetting: (key: string) => Promise<ShopSettingRow | null>;
  /** Сброс memo эффективных настроек (read-your-own-writes). */
  invalidateCache: () => void;
  /** Есть ли опубликованные CMS-страницы (для warning при выключении cms). */
  hasPublishedCmsPages: () => Promise<boolean>;
  /** Валидация загрузки по magic-bytes (storage/validate). */
  validateUpload: (bytes: Buffer, filename: string) => Promise<MediaValidationResult>;
  /** Генерация превью/нормализация в webp (storage/image). */
  generatePreviews: (bytes: Buffer) => Promise<PreviewSet>;
  /** Фабрика хранилища объектов (S3 или local mock). */
  getStorage: () => ObjectStorage;
}

/** Пути инвалидации витрины (форматирование цен/брендинг). */
const STOREFRONT_PATHS = ['/'] as const;
/** Путь раздела настроек админки. */
const SETTINGS_PATH = '/admin/settings';

/**
 * Дефолтный data-чекер: есть ли опубликованные CMS-страницы. Защитно толерантен
 * к отсутствию таблицы cms_pages (пакет 5.C-1 может быть ещё не накатан) —
 * to_regclass вернёт NULL → подзапрос count не выполняется, возвращаем false.
 */
export async function defaultHasPublishedCmsPages(): Promise<boolean> {
  try {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM cms_pages WHERE status = 'published'
      ) AS exists
      WHERE to_regclass('public.cms_pages') IS NOT NULL
    `;
    return rows[0]?.exists ?? false;
  } catch {
    // Таблица отсутствует/иная ошибка чтения → считаем, что данных нет.
    return false;
  }
}

/** Прод-зависимости (реальная БД + дефолтный пайплайн). */
export function productionSettingsDeps(): SettingsActionDeps {
  return {
    actionDeps: defaultDeps,
    upsertSetting: dbUpsertSetting,
    deleteSetting: dbDeleteSetting,
    getSetting: dbGetSetting,
    invalidateCache: invalidateSettingsCache,
    hasPublishedCmsPages: defaultHasPublishedCmsPages,
    validateUpload: defaultValidateUpload,
    generatePreviews: defaultGeneratePreviews,
    getStorage: defaultGetStorage,
  };
}

// =============================================================================
// Фабрика действий.
// =============================================================================

/**
 * Собирает набор settings-actions поверх инъецированных зависимостей.
 * Прод-обёртки (lib/settings/actions.ts) вызывают её с productionSettingsDeps().
 */
export function createSettingsActions(deps: SettingsActionDeps) {
  const { actionDeps } = deps;

  const updateBrandingSettings = defineAction({
    permission: 'settings.manage',
    input: BrandingInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = await deps.getSetting('branding');
      const row = await deps.upsertSetting('branding', data.branding, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { key: 'branding' as const },
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.branding.update',
          entityType: 'shop_settings',
          entityId: 'branding',
          before: before?.value,
          after: row.value,
        },
      };
    },
  });

  const updateCurrencyAndUnits = defineAction({
    permission: 'settings.manage',
    input: CurrencyUnitsInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = {
        currency: (await deps.getSetting('currency'))?.value,
        units: (await deps.getSetting('units'))?.value,
      };
      if (data.currency) await deps.upsertSetting('currency', data.currency, ctx.user.id);
      if (data.units) await deps.upsertSetting('units', data.units, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { keys: ['currency', 'units'] as const },
        // Форматирование цен зависит от валюты → инвалидируем витрину.
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.currency_units.update',
          entityType: 'shop_settings',
          entityId: 'currency,units',
          before,
          after: { currency: data.currency, units: data.units },
        },
      };
    },
  });

  const updateLegalAndContacts = defineAction({
    permission: 'settings.manage',
    input: LegalContactsInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = {
        legal_entity: (await deps.getSetting('legal_entity'))?.value,
        contacts: (await deps.getSetting('contacts'))?.value,
      };
      if (data.legalEntity)
        await deps.upsertSetting('legal_entity', data.legalEntity, ctx.user.id);
      if (data.contacts) await deps.upsertSetting('contacts', data.contacts, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { keys: ['legal_entity', 'contacts'] as const },
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.legal_contacts.update',
          entityType: 'shop_settings',
          entityId: 'legal_entity,contacts',
          before,
          after: { legal_entity: data.legalEntity, contacts: data.contacts },
        },
      };
    },
  });

  const updateCatalogOrdersSettings = defineAction({
    permission: 'settings.manage',
    input: CatalogOrdersInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = {
        catalog: (await deps.getSetting('catalog'))?.value,
        delivery: (await deps.getSetting('delivery'))?.value,
        orders: (await deps.getSetting('orders'))?.value,
      };
      if (data.catalog) await deps.upsertSetting('catalog', data.catalog, ctx.user.id);
      // freeDeliveryThreshold: рубли (ввод) → копейки (хранение).
      let deliveryValue: { freeDeliveryThreshold?: number } | undefined;
      if (data.delivery && data.delivery.freeDeliveryThreshold !== undefined) {
        deliveryValue = { freeDeliveryThreshold: toMinor(data.delivery.freeDeliveryThreshold) };
        await deps.upsertSetting('delivery', deliveryValue, ctx.user.id);
      }
      if (data.orders) await deps.upsertSetting('orders', data.orders, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { keys: ['catalog', 'delivery', 'orders'] as const },
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.catalog_orders.update',
          entityType: 'shop_settings',
          entityId: 'catalog,delivery,orders',
          before,
          after: { catalog: data.catalog, delivery: deliveryValue, orders: data.orders },
        },
      };
    },
  });

  const updateModuleOverrides = defineAction<
    z.infer<typeof ModuleOverridesInputSchema>,
    ModuleOverridesResult
  >({
    permission: 'settings.manage',
    input: ModuleOverridesInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = await deps.getSetting('module_overrides');
      // self-lock невозможен на уровне схемы: 'settings' не входит в
      // moduleOverridesSchema (.strip() отбросит любой неизвестный ключ ещё на
      // этапе валидации). /admin/settings — core-пункт (без module) → не исчезает.
      const row = await deps.upsertSetting(
        'module_overrides',
        data.moduleOverrides,
        ctx.user.id,
      );

      // Мягкие предупреждения: выключение модуля с активными данными НЕ блокирует
      // (данные не удаляются, лишь скрывается UI/API).
      const warnings: string[] = [];
      if (data.moduleOverrides.cms === false && (await deps.hasPublishedCmsPages())) {
        warnings.push('cms_has_published_pages');
      }

      deps.invalidateCache();
      return {
        result: { warnings },
        // Меняется состав меню/доступность роутов → инвалидируем весь /admin и витрину.
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.modules.update',
          entityType: 'shop_settings',
          entityId: 'module_overrides',
          before: before?.value,
          after: row.value,
        },
      };
    },
  });

  const updateShopSeoSettings = defineAction({
    permission: 'settings.manage',
    input: SeoSettingsInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = await deps.getSetting('seo');
      const row = await deps.upsertSetting('seo', data.seo, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { key: 'seo' as const },
        // SEO влияет на sitemap/robots/форму настроек SEO → инвалидируем их.
        revalidate: ['/sitemap.xml', '/robots.txt', '/admin/settings/seo'],
        audit: {
          action: 'settings.seo.update',
          entityType: 'shop_settings',
          entityId: 'seo',
          before: before?.value,
          after: row.value,
        },
      };
    },
  });

  const updateHomeAction = defineAction({
    permission: 'settings.manage',
    input: HomeInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = await deps.getSetting('home');
      const row = await deps.upsertSetting('home', data.home, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { key: 'home' as const },
        // Контент главной → инвалидируем витрину и форму настроек.
        revalidate: [SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.home.update',
          entityType: 'shop_settings',
          entityId: 'home',
          before: before?.value,
          after: row.value,
        },
      };
    },
  });

  const updateNavigationAction = defineAction({
    permission: 'settings.manage',
    input: NavigationInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const before = await deps.getSetting('navigation');
      const row = await deps.upsertSetting('navigation', data.navigation, ctx.user.id);
      deps.invalidateCache();
      return {
        result: { key: 'navigation' as const },
        // Навигация → инвалидируем витрину (шапка/футер) и форму настроек.
        revalidate: [SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.navigation.update',
          entityType: 'shop_settings',
          entityId: 'navigation',
          before: before?.value,
          after: row.value,
        },
      };
    },
  });

  /**
   * Загрузка изображения настроек (логотип/фавикон/og). Переиспользует пайплайн
   * медиа: validateUpload (magic-bytes) → generatePreviews (webp) → storage.put.
   * logo/favicon → URL в branding (logoUrl/faviconUrl); og → КЛЮЧ S3 в
   * seo.default_og_image_key (хранится ключ, не URL — единый контракт SEO/CMS).
   * Значение мерджится в существующий блок (читаем getSetting, не затираем поля).
   */
  const _uploadSettingsImage = defineAction({
    permission: 'settings.manage',
    input: SettingsImageUploadSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      const validation = await deps.validateUpload(data.bytes, data.filename);
      if (!validation.ok || !validation.mime) {
        throw new PublicActionError(validation.error ?? 'Недопустимый файл.');
      }

      const previews = await deps.generatePreviews(data.bytes);
      const main = previews.main;

      const storage = deps.getStorage();
      const key = `settings/${data.kind}/${crypto.randomUUID()}.webp`;
      let put;
      try {
        put = await storage.put(key, main.buffer, 'image/webp');
      } catch {
        throw new PublicActionError('Не удалось сохранить файл в хранилище.');
      }

      // Запись значения в соответствующий ключ настроек (мердж в существующий блок).
      let settingKey: 'branding' | 'seo';
      try {
        if (data.kind === 'og') {
          settingKey = 'seo';
          const current = (await deps.getSetting('seo'))?.value ?? {};
          await deps.upsertSetting(
            'seo',
            { ...current, default_og_image_key: put.key },
            ctx.user.id,
          );
        } else {
          settingKey = 'branding';
          const current = (await deps.getSetting('branding'))?.value ?? {};
          const field = data.kind === 'logo' ? 'logoUrl' : 'faviconUrl';
          await deps.upsertSetting(
            'branding',
            { ...current, [field]: put.url },
            ctx.user.id,
          );
        }
      } catch (err) {
        await storage.delete(put.key).catch(() => {});
        throw err;
      }

      deps.invalidateCache();
      // og отдаёт ключ (контракт SEO), logo/favicon — URL (как branding.*Url).
      const value = data.kind === 'og' ? put.key : put.url;
      return {
        result: { kind: data.kind, key: put.key, url: put.url, value },
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.image.upload',
          entityType: 'shop_settings',
          entityId: settingKey,
          after: { kind: data.kind, key: put.key },
        },
      };
    },
  });

  /**
   * Публичная обёртка загрузки изображения настроек: принимает FormData (kind +
   * file), извлекает байты на сервере и делегирует внутреннему action (guard/
   * Zod/валидация/запись/audit). FormData — родной формат Server Action из формы.
   */
  const uploadSettingsImageAction = async (formData: FormData) => {
    const kind = formData.get('kind');
    const file = formData.get('file');
    if (!(file instanceof Blob)) {
      return _uploadSettingsImage({ kind, filename: 'upload', bytes: undefined });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const filename = file instanceof File ? file.name : 'upload';
    return _uploadSettingsImage({ kind, filename, bytes });
  };

  /**
   * Загрузка изображения, ВОЗВРАЩАЮЩАЯ S3-ключ (без записи в настройки). Для
   * контента главной (home.*): виджет загружает файл, кладёт полученный ключ в
   * поле формы, и форма сохраняет его через updateHomeAction. Пайплайн тот же:
   * validateUpload (magic-bytes) → generatePreviews (webp) → storage.put.
   */
  const _uploadStoreImage = defineAction({
    permission: 'settings.manage',
    input: z.object({
      filename: z.string().max(255).optional().default('upload'),
      bytes: z.instanceof(Buffer),
    }),
    deps: actionDeps,
    handler: async (data, _ctx: ActionCtx) => {
      const validation = await deps.validateUpload(data.bytes, data.filename);
      if (!validation.ok || !validation.mime) {
        throw new PublicActionError(validation.error ?? 'Недопустимый файл.');
      }
      const previews = await deps.generatePreviews(data.bytes);
      const storage = deps.getStorage();
      const key = `settings/home/${crypto.randomUUID()}.webp`;
      let put;
      try {
        put = await storage.put(key, previews.main.buffer, 'image/webp');
      } catch {
        throw new PublicActionError('Не удалось сохранить файл в хранилище.');
      }
      return {
        // ВОЗВРАЩАЕМ ключ (для home.*) + url (для превью в форме). Запись значения
        // в настройки делает updateHomeAction при сохранении формы.
        result: { key: put.key, url: put.url },
        audit: {
          action: 'settings.image.upload',
          entityType: 'shop_settings',
          entityId: 'home',
          after: { key: put.key },
        },
      };
    },
  });

  /** FormData-обёртка загрузки изображения главной: извлекает файл → {key,url}. */
  const uploadStoreImageAction = async (formData: FormData) => {
    const file = formData.get('file');
    if (!(file instanceof Blob)) {
      return _uploadStoreImage({ filename: 'upload', bytes: undefined });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const filename = file instanceof File ? file.name : 'upload';
    return _uploadStoreImage({ filename, bytes });
  };

  const resetSetting = defineAction({
    permission: 'settings.manage',
    input: ResetSettingInputSchema,
    deps: actionDeps,
    handler: async (data, _ctx: ActionCtx) => {
      // Ключ уже провалидирован Zod-enum (известный раздел настроек).
      const before = await deps.getSetting(data.key);
      const deleted = await deps.deleteSetting(data.key);
      deps.invalidateCache();
      return {
        result: { key: data.key, deleted },
        revalidate: ['/admin', SETTINGS_PATH, ...STOREFRONT_PATHS],
        audit: {
          action: 'settings.reset',
          entityType: 'shop_settings',
          entityId: data.key,
          before: before?.value,
        },
      };
    },
  });

  return {
    updateBrandingSettings,
    updateCurrencyAndUnits,
    updateLegalAndContacts,
    updateCatalogOrdersSettings,
    updateModuleOverrides,
    updateShopSeoSettings,
    updateHomeAction,
    updateNavigationAction,
    uploadSettingsImageAction,
    uploadStoreImageAction,
    resetSetting,
  };
}
