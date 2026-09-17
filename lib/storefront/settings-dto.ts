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

/** Публичная социальная ссылка. */
export interface PublicSocialDto {
  type: string;
  url: string;
}

/** Резолвер ключа объекта хранилища → публичный URL (инъекция storage.url). */
export type PublicUrlResolver = (key: string) => string;

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
}

/**
 * Публичная размерная сетка. Набор колонок ПРОИЗВОЛЕН (задаётся в админке),
 * строка — плоский словарь columnKey → значение ячейки. `genders` — значения
 * атрибута товара `gender`, к которым применима сетка; пустой массив = «всегда».
 */
export interface PublicSizeChartDto {
  id: string;
  title: string;
  note?: string;
  genders: string[];
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
}

/** Публичный блок размерных сеток: сетки + общая сноска под таблицей. */
export interface PublicSizeChartsDto {
  charts: PublicSizeChartDto[];
  footnote?: string;
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
  };
  /**
   * Режим оформления заказа — публичный: витрина по нему решает, показывать
   * оплату или заглушку-заявку, и рисовать ли пункт подарочной упаковки.
   */
  checkout: {
    onlinePaymentEnabled: boolean;
    paymentDisabledNotice: string | null;
    giftWrapEnabled: boolean;
    giftWrapLabel: string | null;
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
   * Размерные сетки магазина — публичные (показываются на карточке товара).
   * Пустой charts = сеток нет, витрина не рисует блок «Размерная сетка».
   */
  sizeCharts: PublicSizeChartsDto;
}

/**
 * Преобразует эффективные настройки в публичный DTO витрины.
 * Вырезает приватные поля (bankDetails, og_image_key, robots_extra,
 * noindex_site, module_overrides) и audit-trail. Деньги остаются в копейках.
 */
export function toPublicSettingsDto(
  eff: EffectiveSettings,
  publicUrl: PublicUrlResolver = (k) => k,
  // Реально ли включён модуль `payments` (эквайринг). Онлайн-оплата возможна
  // ТОЛЬКО когда И бизнес-тумблер checkout.onlinePaymentEnabled, И модуль
  // payments включены. Иначе createOrder отклонит онлайн-заказ (payments_disabled),
  // а витрина, доверяя одному тумблеру, увела бы покупателя в тупик. Дефолт true —
  // не менять контракт для вызовов/тестов, которым модульный статус не важен.
  paymentsModuleEnabled = true,
): PublicSettingsDto {
  const onlinePaymentEffective =
    eff.checkout.onlinePaymentEnabled && paymentsModuleEnabled;

  return {
    branding: {
      shopName: eff.branding.shopName,
      logoUrl: eff.branding.logoUrl,
      faviconUrl: eff.branding.faviconUrl,
      theme: {
        primaryColor: eff.branding.theme.primaryColor,
        accentColor: eff.branding.theme.accentColor,
        mode: eff.branding.theme.mode,
      },
      supportEmail: eff.branding.supportEmail,
      supportPhone: eff.branding.supportPhone,
    },
    currency: {
      code: eff.currency.code,
      symbol: eff.currency.symbol,
      locale: eff.currency.locale,
      fractionDigits: eff.currency.fractionDigits,
    },
    units: {
      weight: eff.units.weight,
      dimension: eff.units.dimension,
      system: eff.units.system,
    },
    contacts: {
      phone: eff.contacts.phone ?? null,
      email: eff.contacts.email ?? null,
      address: eff.contacts.address ?? null,
      workingHours: eff.contacts.workingHours ?? null,
      socials: (eff.contacts.socials ?? []).map((s) => ({ type: s.type, url: s.url })),
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
    },
    checkout: {
      onlinePaymentEnabled: onlinePaymentEffective,
      paymentDisabledNotice: eff.checkout.paymentDisabledNotice,
      giftWrapEnabled: eff.checkout.giftWrapEnabled,
      giftWrapLabel: eff.checkout.giftWrapLabel,
    },
    seo: {
      siteName: eff.seo.site_name ?? null,
      siteUrl: eff.seo.site_url ?? null,
      titleTemplate: eff.seo.title_template,
      defaultDescription: eff.seo.default_description ?? null,
      twitterSite: eff.seo.twitter_site ?? null,
      // default_og_image_key (ключ S3), robots_extra, noindex_site — НЕ наружу.
    },
    // home публичен; изображения отдаём как URL (ключи S3 наружу не раскрываем).
    home: {
      hero: {
        title: eff.home.hero.title,
        subtitle: eff.home.hero.subtitle,
        imageUrl: eff.home.hero.imageKey ? publicUrl(eff.home.hero.imageKey) : null,
        ctaLabel: eff.home.hero.ctaLabel,
        ctaHref: eff.home.hero.ctaHref,
      },
      about: {
        title: eff.home.about.title,
        paragraphs: [...eff.home.about.paragraphs],
        imageUrls: eff.home.about.imageKeys.map((k) => publicUrl(k)),
        values: [...eff.home.about.values],
      },
      quality: { title: eff.home.quality.title, items: [...eff.home.quality.items] },
      delivery: { items: eff.home.delivery.items.map((i) => ({ ...i })) },
      valuesStrip: {
        enabled: eff.home.valuesStrip.enabled,
        items: eff.home.valuesStrip.items.map((i) => ({ ...i })),
      },
      philosophy: { ...eff.home.philosophy },
    },
    navigation: {
      header: eff.navigation.header.map((i) => ({ label: i.label, href: i.href })),
      footer: eff.navigation.footer.map((c) => ({
        title: c.title,
        links: c.links.map((l) => ({ label: l.label, href: l.href })),
      })),
    },
    sizeCharts: {
      charts: eff.sizeCharts.charts.map((c) => ({
        id: c.id,
        title: c.title,
        ...(c.note ? { note: c.note } : {}),
        genders: [...c.genders],
        columns: c.columns.map((col) => ({ key: col.key, label: col.label })),
        rows: c.rows.map((r) => ({ ...r })),
      })),
      ...(eff.sizeCharts.footnote ? { footnote: eff.sizeCharts.footnote } : {}),
    },
  };
}
