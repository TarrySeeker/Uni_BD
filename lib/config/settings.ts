/**
 * Слой ЭФФЕКТИВНЫХ настроек магазина (docs/11 §5.4, ADR-013).
 *
 * Превращает стек из env-driven в DB-driven: env = дефолт, строка БД = частичный
 * оверрайд на уровне полей. Пустой объект `{}` в БД = «нет оверрайда» → env.
 *
 * Состав:
 *   - mergeSettings(env, dbRows)  — ЧИСТАЯ функция (env ⊕ БД), тестируется без БД.
 *   - getEffectiveSettings()      — читает БД ОДИН раз и мемоизирует (module-level).
 *   - invalidateSettingsCache()   — сбрасывает memo (read-your-own-writes из actions).
 *   - getEffectiveModules(env, o) — поверх getEnabledModules накладывает module_overrides.
 *
 * Деньги в эффективных настройках — в КОПЕЙКАХ (int). Конвертация в рубли — только
 * на границе записи в legacy numeric(14,2)-поля (репозиторий заказов), не здесь.
 */

import { getEnv, type Env } from '@/lib/config/env';
import {
  getEnabledModules,
  ALL_MODULES,
  type ModuleName,
} from '@/lib/config/modules';
import {
  parseSettingValue,
  type ModuleOverrides,
  type BrandingSettings,
  type CurrencySettings,
  type UnitsSettings,
  type ContactsSettings,
  type LegalEntitySettings,
  type SeoSettings,
  type HomeSettings,
  type NavigationSettings,
} from '@/lib/settings/schemas';
import { HOME_DEFAULTS, type HomeContent } from '@/lib/config/home-defaults';
import { toMinor } from '@/lib/orders/money';
import { getAllSettings, type SettingRow } from '@/lib/settings/repository';

// -----------------------------------------------------------------------------
// Контракт эффективных настроек.
// -----------------------------------------------------------------------------

/** Эффективные настройки магазина (env ⊕ БД). Деньги — в копейках. */
export interface EffectiveSettings {
  branding: {
    shopName: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    theme: {
      primaryColor: string | null;
      accentColor: string | null;
      mode: 'light' | 'dark' | 'system';
    };
    supportEmail: string | null;
    supportPhone: string | null;
  };
  currency: {
    code: string;
    symbol: string | null;
    locale: string | null;
    fractionDigits: number;
  };
  units: {
    weight: 'g' | 'kg';
    dimension: 'cm' | 'mm';
    system: 'metric';
  };
  contacts: ContactsSettings;
  legalEntity: LegalEntitySettings;
  catalog: {
    /** Порог «новизны» товара в днях. */
    newProductDays: number;
  };
  delivery: {
    /** Порог бесплатной доставки — в КОПЕЙКАХ (0 = выключено). */
    freeDeliveryThreshold: number;
  };
  orders: {
    orderPrefix: string;
  };
  seo: SeoSettings & {
    /** Гарантированно непустой шаблон заголовка. */
    title_template: string;
    noindex_site: boolean;
  };
  /**
   * Контент главной страницы (ADR-018). Все блоки заполнены: оверрайд блока из
   * БД заменяет блок целиком, отсутствующий блок → HOME_DEFAULTS (фолбэк
   * витрины). Изображения хранятся ключами S3 (imageKey/imageKeys), не URL.
   */
  home: HomeContent;
  /**
   * Распарсенный module_overrides из БД (частичный оверрайд ADMIK_MODULES).
   * Несётся в эффективных настройках, чтобы рантайм-гейты (getEffectiveModuleSet)
   * получали авторитетный набор модулей через тот же memo-кэш, что и остальные
   * настройки (read-your-own-writes после updateModuleOverrides). Пустой объект
   * = «нет оверрайда» → берётся env-набор.
   */
  modules: {
    overrides: ModuleOverrides;
  };
  /**
   * Навигация витрины (G-10/G-11): меню шапки и колонки футера. Пустые массивы =
   * «не задано» → витрина показывает навигацию по умолчанию (фолбэк на её стороне).
   */
  navigation: {
    header: { label: string; href: string }[];
    footer: { title: string; links: { label: string; href: string }[] }[];
  };
}

// -----------------------------------------------------------------------------
// mergeSettings — ЧИСТАЯ функция env ⊕ БД.
// -----------------------------------------------------------------------------

/**
 * Очищает URL логотипа: пустое/невалидное/плейсхолдер `example.com` (из
 * `.env.example`) → null, чтобы в шапке админки не висела «битая картинка».
 * Реальный битый URL дополнительно гасится onError в ShopLogo (клиент).
 */
function cleanLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === 'example.com' || host === 'www.example.com' || host === 'example.org') {
      return null;
    }
    return trimmed;
  } catch {
    return null; // невалидный URL → не рендерим логотип
  }
}

/**
 * Сливает контент главной: для каждого блока — если в БД задан оверрайд блока,
 * берётся он (отсутствующие внутри поля добиваются дефолтом, чтобы HomeContent
 * был полностью заполнен и виджеты витрины не падали на null-блоке); иначе —
 * дефолт блока целиком. Это «оверрайд блока» (а не поля), как и семантика JSONB
 * value для остальных ключей: строка БД хранит конкретный блок целиком.
 */
function mergeHome(db: HomeSettings): HomeContent {
  return {
    hero: db.hero
      ? {
          title: db.hero.title ?? null,
          subtitle: db.hero.subtitle ?? null,
          imageKey: db.hero.imageKey ?? null,
          ctaLabel: db.hero.ctaLabel ?? null,
          ctaHref: db.hero.ctaHref ?? null,
        }
      : HOME_DEFAULTS.hero,
    about: db.about
      ? {
          title: db.about.title ?? HOME_DEFAULTS.about.title,
          paragraphs: db.about.paragraphs ?? [],
          imageKeys: db.about.imageKeys ?? [],
          values: db.about.values ?? [],
        }
      : HOME_DEFAULTS.about,
    quality: db.quality
      ? {
          title: db.quality.title ?? HOME_DEFAULTS.quality.title,
          items: db.quality.items ?? [],
        }
      : HOME_DEFAULTS.quality,
    delivery: db.delivery?.items
      ? { items: db.delivery.items.map((i) => ({ title: i.title, text: i.text })) }
      : HOME_DEFAULTS.delivery,
  };
}

/** Индексирует строки БД по ключу с безопасным парсом значения. */
function indexRows(dbRows: SettingRow[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of dbRows) {
    if (!map.has(row.setting_key)) {
      map.set(row.setting_key, row.value ?? {});
    }
  }
  return map;
}

/**
 * Сливает env-дефолты со строками БД. Частичный merge на уровне полей: каждое
 * поле берётся из БД, если задано и валидно, иначе из env. Невалидная/пустая
 * строка БД для ключа эквивалентна её отсутствию (раздел падает на env).
 */
export function mergeSettings(env: Env, dbRows: SettingRow[]): EffectiveSettings {
  const rows = indexRows(dbRows);

  const branding: BrandingSettings = parseSettingValue('branding', rows.get('branding')) ?? {};
  const currency: CurrencySettings = parseSettingValue('currency', rows.get('currency')) ?? {};
  const units: UnitsSettings = parseSettingValue('units', rows.get('units')) ?? {};
  const contacts: ContactsSettings = parseSettingValue('contacts', rows.get('contacts')) ?? {};
  const legalEntity: LegalEntitySettings =
    parseSettingValue('legal_entity', rows.get('legal_entity')) ?? {};
  const catalog = parseSettingValue('catalog', rows.get('catalog')) ?? {};
  const delivery = parseSettingValue('delivery', rows.get('delivery')) ?? {};
  const orders = parseSettingValue('orders', rows.get('orders')) ?? {};
  const seo: SeoSettings = parseSettingValue('seo', rows.get('seo')) ?? {};
  const home: HomeSettings = parseSettingValue('home', rows.get('home')) ?? {};
  const navigation: NavigationSettings =
    parseSettingValue('navigation', rows.get('navigation')) ?? {};
  // module_overrides — мягкий парс (.strip): кривая строка БД → {} (нет оверрайда).
  const moduleOverrides: ModuleOverrides =
    parseSettingValue('module_overrides', rows.get('module_overrides')) ?? {};

  return {
    branding: {
      shopName: branding.shopName ?? env.SHOP_NAME ?? 'Admik',
      logoUrl: cleanLogoUrl(branding.logoUrl ?? env.SHOP_LOGO_URL),
      faviconUrl: branding.faviconUrl ?? null,
      theme: {
        primaryColor: branding.theme?.primaryColor ?? null,
        accentColor: branding.theme?.accentColor ?? null,
        mode: branding.theme?.mode ?? 'system',
      },
      supportEmail: branding.supportEmail ?? null,
      supportPhone: branding.supportPhone ?? null,
    },
    currency: {
      code: currency.code ?? env.SHOP_CURRENCY,
      symbol: currency.symbol ?? null,
      locale: currency.locale ?? null,
      fractionDigits: currency.fractionDigits ?? 2,
    },
    units: {
      weight: units.weight ?? 'g',
      dimension: units.dimension ?? 'cm',
      system: 'metric',
    },
    contacts,
    legalEntity,
    catalog: {
      newProductDays: catalog.newProductDays ?? env.SHOP_NEW_PRODUCT_DAYS,
    },
    delivery: {
      // env-порог задаётся в рублях (number) → конвертируем в копейки.
      // БД-значение уже в копейках (int) → берём как есть.
      freeDeliveryThreshold:
        delivery.freeDeliveryThreshold ?? toMinor(env.SHOP_FREE_DELIVERY_THRESHOLD),
    },
    orders: {
      orderPrefix: orders.orderPrefix ?? env.SHOP_ORDER_PREFIX,
    },
    seo: {
      site_name: seo.site_name ?? branding.shopName ?? env.SHOP_NAME ?? undefined,
      site_url: seo.site_url ?? undefined,
      title_template: seo.title_template ?? '%s',
      default_description: seo.default_description ?? undefined,
      default_og_image_key: seo.default_og_image_key ?? undefined,
      robots_extra: seo.robots_extra ?? undefined,
      twitter_site: seo.twitter_site ?? undefined,
      noindex_site: seo.noindex_site ?? false,
    },
    home: mergeHome(home),
    modules: {
      overrides: moduleOverrides,
    },
    navigation: {
      header: navigation.header ?? [],
      footer: (navigation.footer ?? []).map((c) => ({ title: c.title, links: c.links ?? [] })),
    },
  };
}

// -----------------------------------------------------------------------------
// getEffectiveModules — env ⊕ module_overrides.
// -----------------------------------------------------------------------------

/**
 * Эффективный набор модулей: базовый env-набор (getEnabledModules) с наложенным
 * частичным module_overrides. Отсутствие ключа в оверрайде → берётся env;
 * `true` включает модуль, `false` выключает. Результат — подмножество
 * ALL_MODULES без дублей.
 */
export function getEffectiveModules(
  env: Record<string, string | undefined> = process.env,
  dbOverrides: ModuleOverrides = {},
): ModuleName[] {
  const base = new Set<ModuleName>(getEnabledModules(env));
  for (const mod of ALL_MODULES) {
    const override = dbOverrides[mod];
    if (override === true) {
      base.add(mod);
    } else if (override === false) {
      base.delete(mod);
    }
  }
  // Детерминированный порядок — по ALL_MODULES.
  return ALL_MODULES.filter((m) => base.has(m));
}

// -----------------------------------------------------------------------------
// getEffectiveSettings — чтение БД с module-level мемоизацией.
// -----------------------------------------------------------------------------

/** Зависимости getEffectiveSettings (инъекция для тестов без БД). */
export interface EffectiveSettingsDeps {
  /** Читатель строк настроек из БД (по умолчанию — репозиторий getAllSettings). */
  readRows?: () => Promise<SettingRow[]>;
  /** Источник env (по умолчанию — getEnv()). */
  env?: Env;
}

/**
 * Состояние memo-кэша эффективных настроек.
 *
 * ⚠️ Хранится на globalThis (через registry-Symbol), а НЕ в модульных `let`.
 * Причина: Next.js инстанцирует один и тот же модуль (`lib/config/settings`) в
 * РАЗНЫХ серверных бандлах — отдельно для Server Actions и отдельно для Route
 * Handlers/RSC. С модульными переменными у каждого бандла была бы СВОЯ копия
 * memo: invalidateSettingsCache() из settings-action сбрасывал бы кэш только
 * СВОЕГО экземпляра, а публичный GET /api/storefront/v1/settings читал бы memo
 * ДРУГОГО экземпляра и бесконечно отдавал устаревший снимок — вплоть до рестарта
 * процесса app. Именно так проявлялся баг «правка контента в админке сохраняется
 * в БД, но не видна на витрине». globalThis — единственный объект, общий для всех
 * экземпляров модуля в одном процессе, поэтому и кэш, и его инвалидация
 * становятся по-настоящему процесс-широкими. Registry-Symbol (Symbol.for) даёт
 * один и тот же ключ во всех бандлах. Прямая правка shop_settings в БД (внешний
 * SQL) по-прежнему требует рестарта app — invalidate из неё не вызывается.
 */
interface SettingsCacheState {
  /** Снапшот эффективных настроек (1 чтение БД на процесс до инвалидации). */
  cached: EffectiveSettings | undefined;
  /** In-flight промис, чтобы конкурентные вызовы дали ОДНО чтение БД. */
  inflight: Promise<EffectiveSettings> | undefined;
  /**
   * Монотонный счётчик поколений кеша (epoch/generation guard против TOCTOU).
   * invalidateSettingsCache() инкрементирует его. In-flight IIFE захватывает
   * epoch ДО `await read()` и кеширует результат ТОЛЬКО если epoch не сменился за
   * время чтения. Иначе во время зависшего SELECT произошла запись настроек +
   * инвалидация → прочитанный снапшот устарел, кешировать его нельзя (иначе
   * перезапишет инвалидацию и сломает read-your-own-writes по всей поверхности
   * рантайм-гейтов).
   */
  cacheEpoch: number;
}

/** Registry-Symbol: одинаков во всех бандлах/экземплярах модуля одного процесса. */
const SETTINGS_CACHE_SLOT = Symbol.for('admik.config.settings.effectiveCache');

/** Возвращает (создавая однажды) общее на процесс состояние кэша из globalThis. */
function settingsCache(): SettingsCacheState {
  const store = globalThis as unknown as Record<symbol, SettingsCacheState | undefined>;
  let state = store[SETTINGS_CACHE_SLOT];
  if (!state) {
    state = { cached: undefined, inflight: undefined, cacheEpoch: 0 };
    store[SETTINGS_CACHE_SLOT] = state;
  }
  return state;
}

/**
 * Возвращает эффективные настройки. Читает БД ОДИН раз и мемоизирует (на процесс,
 * через globalThis — общий кэш для всех бандлов Next). `invalidateSettingsCache()`
 * вызывается из каждого settings-action для read-your-own-writes. Redis-кеш —
 * задел на будущее (1 магазин = 1 БД).
 */
export async function getEffectiveSettings(
  deps: EffectiveSettingsDeps = {},
): Promise<EffectiveSettings> {
  const state = settingsCache();
  if (state.cached) return state.cached;
  if (state.inflight) return state.inflight;

  const read = deps.readRows ?? getAllSettings;
  const env = deps.env ?? getEnv();

  const mine = (async () => {
    // Захватываем поколение кеша ДО зависающего чтения. Если за время await
    // произошла инвалидация (cacheEpoch сменился) — снапшот устарел: возвращаем
    // его вызывающему (read-your-own-read), но НЕ кешируем (не затираем инвалидацию).
    const startEpoch = state.cacheEpoch;
    const rows = await read();
    const merged = mergeSettings(env, rows);
    if (startEpoch === state.cacheEpoch) state.cached = merged;
    return merged;
  })();
  state.inflight = mine;

  try {
    return await mine;
  } finally {
    // Снимаем только СВОЙ in-flight: если за время чтения была инвалидация и
    // стартовал новый read, его промис не должен быть затёрт.
    if (state.inflight === mine) state.inflight = undefined;
  }
}

/**
 * Сбрасывает memo эффективных настроек. Вызывается в каждом settings-action
 * после успешной мутации (read-your-own-writes) и в тестах.
 */
export function invalidateSettingsCache(): void {
  const state = settingsCache();
  // Инкремент поколения «отзывает» право любого in-flight чтения закешировать
  // свой (уже устаревший) снапшот — см. epoch-guard в getEffectiveSettings.
  state.cacheEpoch += 1;
  state.cached = undefined;
  state.inflight = undefined;
}

// -----------------------------------------------------------------------------
// АВТОРИТЕТНЫЙ рантайм-гейт модулей: env-набор ⊕ module_overrides из БД.
// -----------------------------------------------------------------------------

/**
 * Возвращает ЭФФЕКТИВНЫЙ набор включённых модулей (env ⊕ БД-оверрайд) как Set.
 *
 * Это авторитетный гейт для рантайма: в отличие от синхронного isModuleEnabled
 * (читает только process.env), он учитывает module_overrides из shop_settings —
 * именно то, что пишет updateModuleOverrides из UI. Использует тот же memo-кэш
 * getEffectiveSettings (read-your-own-writes уже работает через invalidateCache).
 *
 * Контракт обратной совместимости: при ОТСУТСТВИИ оверрайда (пустой module_overrides)
 * результат совпадает с env-набором (getEnabledModules). Если чтение БД невозможно
 * (DATABASE_URL не задан / БД недоступна — сборка, ранний старт, тесты без БД), гейт
 * НЕ роняет вызывающего, а мягко откатывается на чистый env-набор — поведение тогда
 * идентично прежнему синхронному isModuleEnabled.
 *
 * @param deps - инъекция readRows/env для тестов без БД (как у getEffectiveSettings).
 */
export async function getEffectiveModuleSet(
  deps: EffectiveSettingsDeps = {},
): Promise<Set<ModuleName>> {
  const env = deps.env ?? getEnv();
  // getEffectiveModules читает только ADMIK_MODULES — отдаём строковую проекцию
  // (типизированный Env с boolean/number полями не присваивается Record<string,string>).
  const envProjection: Record<string, string | undefined> = { ADMIK_MODULES: env.ADMIK_MODULES };
  try {
    const eff = await getEffectiveSettings(deps);
    return new Set(getEffectiveModules(envProjection, eff.modules.overrides));
  } catch {
    // БД недоступна/не сконфигурирована → авторитетен только env (как раньше).
    return new Set(getEffectiveModules(envProjection, {}));
  }
}

/**
 * Включён ли модуль с учётом БД-оверрайда (авторитетная рантайм-проверка).
 * Async-аналог isModuleEnabled: без оверрайда поведение совпадает с env.
 */
export async function isModuleEffectivelyEnabled(
  name: ModuleName,
  deps: EffectiveSettingsDeps = {},
): Promise<boolean> {
  const set = await getEffectiveModuleSet(deps);
  return set.has(name);
}
