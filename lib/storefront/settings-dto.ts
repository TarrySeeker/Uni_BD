/**
 * Публичный DTO настроек магазина для Storefront API (docs/11 §5.4.4, ADR-008).
 *
 * ПРИНЦИП DTO-изоляции (§7): витрине отдаём ТОЛЬКО публично-безопасные поля.
 * СКРЫВАЕМ:
 *   - audit-trail строки (`updated_by`/`updated_at`) — внутренняя информация;
 *   - `legalEntity.bankDetails` — приватные банковские реквизиты;
 *   - оверрайд модулей (`module_overrides`) — внутренняя конфигурация;
 *   - приватные SEO-ключи (`default_og_image_key` — ключ S3, не URL).
 *
 * ОТДАЁМ: брендинг (без приватных полей), валюту, единицы, публичные контакты,
 * публичные реквизиты юрлица (без банковских), порог бесплатной доставки (копейки),
 * публичные SEO-дефолты (site_name/site_url/title_template/...). Деньги — в КОПЕЙКАХ.
 *
 * Чистая функция — тестируется без БД/Next. Источник — `EffectiveSettings`
 * (env ⊕ БД), сам по себе уже без audit-полей; DTO дополнительно вырезает
 * приватные части (bankDetails, og_image_key).
 */

import type { EffectiveSettings } from '@/lib/config/settings';
import { localizeStructured, isNonEmptyValue } from '@/lib/i18n';
import { SETTINGS_TR_FIELDS } from '@/lib/settings/schemas';
import type { LocalizeCtx } from './locale';

/** Публичная социальная ссылка. */
export interface PublicSocialDto {
  type: string;
  url: string;
}

/** Публичная зона доставки (ТЗ_1). Деньги — в КОПЕЙКАХ; freeThreshold null, если не задан. */
export interface PublicDeliveryZoneDto {
  id: string;
  label: string;
  price: number;
  freeThreshold: number | null;
}

/** Резолвер ключа объекта хранилища → публичный URL (инъекция storage.url). */
export type PublicUrlResolver = (key: string) => string;

/**
 * Публичная валюта ОТОБРАЖЕНИЯ (мультивалюта витрины). rate — единиц базовой
 * валюты за 1 единицу этой (EUR rate=100 → цена_€ = цена_₽ / 100). Витрина сама
 * пересчитывает и форматирует. Никаких реальных денег в этой валюте — только показ.
 */
export interface PublicDisplayCurrencyDto {
  code: string;
  symbol: string;
  rate: number;
  fractionDigits: number;
}

/**
 * Публичный контент главной (ADR-018). Весь home публичен (редактируемый
 * витринный контент, без приватных полей). Изображения отдаём как ПУБЛИЧНЫЕ URL
 * (imageUrl/imageUrls) — сырые S3-ключи наружу НЕ раскрываем (инвариант, зеркально
 * каталог-медиа и CMS-секциям). Резолв ключ→URL делает роут через storage.url.
 */
export interface PublicHomeDto {
  hero: {
    title: string | null;
    subtitle: string | null;
    imageUrl: string | null;
    ctaLabel: string | null;
    ctaHref: string | null;
  };
  about: { title: string; paragraphs: string[]; imageUrls: string[]; values: string[] };
  quality: { title: string; items: string[] };
  delivery: { items: { title: string; text: string }[] };
  /** B1 — лента ценностей: показ (enabled) + тезисы. По умолчанию скрыта. */
  valuesStrip: { enabled: boolean; items: { title: string; text: string }[] };
  /** B3 — философия: надзаголовок/заголовок/абзац + ссылка. */
  philosophy: {
    eyebrow: string;
    title: string;
    text: string;
    linkLabel: string;
    linkHref: string;
  };
  /**
   * ТЗ_2 — «Образы» (lookbook): показ + опц. заголовок + категории. Каждая
   * категория несёт imageUrl (НЕ imageKey) — сырой S3-ключ наружу не раскрываем.
   */
  looks: {
    enabled: boolean;
    title: string;
    categories: { title: string; text: string; imageUrl: string }[];
  };
  /**
   * M4 — «Плитки категорий»: показ + плитки. Каждая плитка несёт imageUrl (НЕ
   * imageKey) — сырой S3-ключ наружу не раскрываем (инвариант looks/media).
   */
  tiles: {
    enabled: boolean;
    items: { title: string; href: string; imageUrl: string }[];
  };
  /** M4 — «Видео»: показ + embedUrl (уже URL, отдаём как есть). */
  video: {
    enabled: boolean;
    embedUrl: string;
  };
  /**
   * M4 — «Дизайнеры»: показ + опц. заголовок + записи. Каждая запись несёт
   * avatarUrl/workUrl (НЕ ключи) + avatarTop/workTop; сырые S3-ключи не наружу.
   */
  designers: {
    enabled: boolean;
    title: string;
    items: {
      name: string;
      href: string;
      avatarUrl: string;
      workUrl: string;
      avatarTop: number;
      workTop: number;
    }[];
  };
  /**
   * M5 — «Промо-слайдер»: показ + слайды. Каждый слайд несёт imageUrl (НЕ
   * imageKey) — сырой S3-ключ наружу не раскрываем (инвариант looks/tiles/media).
   */
  slider: {
    enabled: boolean;
    slides: { imageUrl: string; href: string; name: string; caption: string }[];
  };
  /**
   * M5 — «Корпоративным / сертификаты»: показ + плитки. Каждая плитка несёт
   * imageUrl (НЕ imageKey) — сырой S3-ключ наружу не раскрываем.
   */
  corpCert: {
    enabled: boolean;
    tiles: { imageUrl: string; href: string; title: string }[];
  };
}

/** Публичный DTO настроек магазина (наружу витрине). */
export interface PublicSettingsDto {
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
    /**
     * Доп.валюты ОТОБРАЖЕНИЯ (мультивалюта, ₽/€): базовая — code выше, эти —
     * переключаемые на витрине для показа по курсу. Пустой список = только базовая
     * (анти-регресс: старый рублёвый показ без выбора). rate/fractionDigits — для
     * пересчёта и формата на стороне витрины. Реальные деньги — всегда в базовой.
     */
    displayCurrencies: PublicDisplayCurrencyDto[];
  };
  units: {
    weight: 'g' | 'kg';
    dimension: 'cm' | 'mm';
    system: 'metric';
  };
  contacts: {
    phone: string | null;
    email: string | null;
    address: string | null;
    workingHours: string | null;
    socials: PublicSocialDto[];
  };
  /** Публичные реквизиты юрлица — БЕЗ bankDetails. */
  legalEntity: {
    name: string | null;
    inn: string | null;
    kpp: string | null;
    ogrn: string | null;
    legalAddress: string | null;
  };
  delivery: {
    /** Порог бесплатной доставки — в КОПЕЙКАХ (0 = выключено). */
    freeDeliveryThreshold: number;
    /**
     * Зоны доставки (ТЗ_1): витрина рендерит селектор зон. Деньги — в КОПЕЙКАХ.
     * freeThreshold — порог бесплатной доставки для зоны (null, если не задан).
     */
    zones: PublicDeliveryZoneDto[];
  };
  seo: {
    siteName: string | null;
    siteUrl: string | null;
    titleTemplate: string;
    defaultDescription: string | null;
    twitterSite: string | null;
  };
  /** Редактируемый контент главной (ADR-018) — публичный. */
  home: PublicHomeDto;
  /** Навигация витрины (G-10/G-11): меню шапки и колонки футера — публичная. */
  navigation: {
    header: { label: string; href: string }[];
    footer: { title: string; links: { label: string; href: string }[] }[];
  };
  /**
   * Набор языков магазина (ключ i18n ∩ whitelist платформы). Контракт для витрины:
   * выключение языка в админке убирает его отсюда — витрина рендерит переключатель
   * только по этому набору. defaultLocale — язык базовых (непереведённых) полей.
   */
  i18n: {
    defaultLocale: string;
    locales: string[];
  };
}

/**
 * Точечная локализация ПЛОСКОГО ключа настроек по whitelist полей: непустое
 * значение из патча перекрывает базу, всё непереводимое (телефон/почта/URL/цвета)
 * остаётся нетронутым. `patch` — сырой per-locale-per-section фрагмент оверлея.
 * Возвращает базу без клонирования, если накладывать нечего.
 */
function localizeFlat<T extends object>(
  base: T,
  patch: unknown,
  fields: readonly string[],
): T {
  if (patch == null || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const f of fields) {
    if (isNonEmptyValue(p[f])) {
      out ??= { ...base } as Record<string, unknown>;
      out[f] = p[f];
    }
  }
  return (out ?? base) as T;
}

/**
 * Структурная локализация ключа настроек (home/navigation): deep-merge патча
 * поверх базы (массивы по индексу) тем же движком, что и CMS-секции. Патч несёт
 * только переводимые поля; imageKey/href/enabled в патче отсутствуют → база цела.
 */
function localizeStruct<T>(base: T, patch: unknown, loc: LocalizeCtx): T {
  if (patch == null || typeof patch !== 'object') return base;
  return localizeStructured(
    base,
    { [loc.locale]: patch as Record<string, unknown> },
    loc.locale,
    loc.defaultLocale,
  ) as T;
}

/**
 * Преобразует эффективные настройки в публичный DTO витрины.
 * Вырезает приватные поля (bankDetails, og_image_key, robots_extra,
 * noindex_site, module_overrides) и audit-trail. Деньги остаются в копейках.
 */
export function toPublicSettingsDto(
  eff: EffectiveSettings,
  publicUrl: PublicUrlResolver = (k) => k,
  loc?: LocalizeCtx,
): PublicSettingsDto {
  // Оверлей переводов активен только для НЕ дефолтного языка. Иначе (loc не задан
  // или запрошен язык-канон) — patch=undefined → все localize* возвращают базу без
  // изменений: форма и значения DTO байт-в-байт как раньше (обратная совместимость).
  const patch =
    loc && loc.locale !== loc.defaultLocale
      ? (eff.contentI18n[loc.locale] as Record<string, unknown> | undefined)
      : undefined;

  // 🔴 Локализуем БАЗОВЫЕ формы (home ещё с imageKey!) СТРОГО ДО резолва ключей в
  // URL ниже — иначе deep-merge патча поехал бы по уже подменённым картинкам/ссылкам.
  const branding = localizeFlat(eff.branding, patch?.branding, SETTINGS_TR_FIELDS.branding);
  const seo = localizeFlat(eff.seo, patch?.seo, SETTINGS_TR_FIELDS.seo);
  const contacts = localizeFlat(eff.contacts, patch?.contacts, SETTINGS_TR_FIELDS.contacts);
  const home = loc ? localizeStruct(eff.home, patch?.home, loc) : eff.home;
  const navigation = loc ? localizeStruct(eff.navigation, patch?.navigation, loc) : eff.navigation;

  return {
    branding: {
      shopName: branding.shopName,
      logoUrl: branding.logoUrl,
      faviconUrl: branding.faviconUrl,
      theme: {
        primaryColor: branding.theme.primaryColor,
        accentColor: branding.theme.accentColor,
        mode: branding.theme.mode,
      },
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
    },
    currency: {
      code: eff.currency.code,
      symbol: eff.currency.symbol,
      locale: eff.currency.locale,
      fractionDigits: eff.currency.fractionDigits,
      // Доп.валюты отображения (₽/€): rate/symbol/fractionDigits наружу — витрина
      // пересчитывает цену_₽ / rate сама. autoRate/rateUpdatedAt НЕ отдаём (внутренние).
      displayCurrencies: eff.exchange.displayCurrencies.map((d) => ({
        code: d.code,
        symbol: d.symbol,
        rate: d.rate,
        fractionDigits: d.fractionDigits,
      })),
    },
    units: {
      weight: eff.units.weight,
      dimension: eff.units.dimension,
      system: eff.units.system,
    },
    contacts: {
      phone: contacts.phone ?? null,
      email: contacts.email ?? null,
      address: contacts.address ?? null,
      workingHours: contacts.workingHours ?? null,
      socials: (contacts.socials ?? []).map((s) => ({ type: s.type, url: s.url })),
    },
    legalEntity: {
      name: eff.legalEntity.name ?? null,
      inn: eff.legalEntity.inn ?? null,
      kpp: eff.legalEntity.kpp ?? null,
      ogrn: eff.legalEntity.ogrn ?? null,
      legalAddress: eff.legalEntity.legalAddress ?? null,
      // bankDetails намеренно НЕ включён — приватные реквизиты.
    },
    delivery: {
      freeDeliveryThreshold: eff.delivery.freeDeliveryThreshold,
      zones: eff.delivery.zones.map((z) => ({
        id: z.id,
        label: z.label,
        price: z.price,
        freeThreshold: z.freeThreshold ?? null,
      })),
    },
    seo: {
      siteName: seo.site_name ?? null,
      siteUrl: seo.site_url ?? null,
      titleTemplate: seo.title_template,
      defaultDescription: seo.default_description ?? null,
      twitterSite: seo.twitter_site ?? null,
      // default_og_image_key (ключ S3), robots_extra, noindex_site — НЕ наружу.
    },
    // home публичен; изображения отдаём как URL (ключи S3 наружу не раскрываем).
    // Значения уже локализованы (см. `home` выше) ДО резолва ключей в URL.
    home: {
      hero: {
        title: home.hero.title,
        subtitle: home.hero.subtitle,
        imageUrl: home.hero.imageKey ? publicUrl(home.hero.imageKey) : null,
        ctaLabel: home.hero.ctaLabel,
        ctaHref: home.hero.ctaHref,
      },
      about: {
        title: home.about.title,
        paragraphs: [...home.about.paragraphs],
        imageUrls: home.about.imageKeys.map((k) => publicUrl(k)),
        values: [...home.about.values],
      },
      quality: { title: home.quality.title, items: [...home.quality.items] },
      delivery: { items: home.delivery.items.map((i) => ({ ...i })) },
      valuesStrip: {
        enabled: home.valuesStrip.enabled,
        items: home.valuesStrip.items.map((i) => ({ ...i })),
      },
      philosophy: { ...home.philosophy },
      looks: {
        enabled: home.looks.enabled,
        title: home.looks.title,
        categories: home.looks.categories.map((c) => ({
          title: c.title,
          text: c.text,
          imageUrl: publicUrl(c.imageKey),
        })),
      },
      tiles: {
        enabled: home.tiles.enabled,
        items: home.tiles.items.map((t) => ({
          title: t.title,
          href: t.href,
          imageUrl: publicUrl(t.imageKey),
        })),
      },
      // embedUrl уже публичный https-URL (провалидирован схемой) — проброс как есть.
      video: {
        enabled: home.video.enabled,
        embedUrl: home.video.embedUrl,
      },
      designers: {
        enabled: home.designers.enabled,
        title: home.designers.title,
        items: home.designers.items.map((d) => ({
          name: d.name,
          href: d.href,
          avatarUrl: publicUrl(d.avatarImageKey),
          workUrl: publicUrl(d.workImageKey),
          avatarTop: d.avatarTop,
          workTop: d.workTop,
        })),
      },
      slider: {
        enabled: home.slider.enabled,
        slides: home.slider.slides.map((sl) => ({
          imageUrl: publicUrl(sl.imageKey),
          href: sl.href,
          name: sl.name,
          caption: sl.caption,
        })),
      },
      corpCert: {
        enabled: home.corpCert.enabled,
        tiles: home.corpCert.tiles.map((t) => ({
          imageUrl: publicUrl(t.imageKey),
          href: t.href,
          title: t.title,
        })),
      },
    },
    navigation: {
      header: navigation.header.map((i) => ({ label: i.label, href: i.href })),
      footer: navigation.footer.map((c) => ({
        title: c.title,
        links: c.links.map((l) => ({ label: l.label, href: l.href })),
      })),
    },
    i18n: {
      defaultLocale: eff.i18n.defaultLocale,
      locales: [...eff.i18n.locales],
    },
  };
}
