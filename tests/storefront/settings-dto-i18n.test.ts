import { describe, it, expect } from 'vitest';

import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import type { EffectiveSettings } from '@/lib/config/settings';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Волна 5, п.5 ТЗ — локализация настроек в toPublicSettingsDto через оверлей
 * content_i18n. Проверяем: перевод home/navigation (deep-merge, массивы по
 * индексу) + точечный перевод branding/seo/contacts по whitelist; НЕпереводимое
 * (imageKey→URL, href, phone) остаётся целым; locale===default и отсутствие
 * оверлея → байт-в-байт как раньше; контракт i18n в DTO.
 */
function makeEffective(): EffectiveSettings {
  return {
    modules: { overrides: {} },
    access: { singleUserMode: false },
    contentI18n: {},
    i18n: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
    home: {
      ...HOME_DEFAULTS,
      hero: {
        title: 'Шёлк',
        subtitle: 'Платки',
        imageKey: 'home/hero.webp',
        ctaLabel: 'Смотреть',
        ctaHref: '/catalog',
      },
      about: {
        title: 'О нас',
        paragraphs: ['Первый', 'Второй'],
        imageKeys: ['home/a1.webp', 'home/a2.webp'],
        values: ['Качество', 'Сервис'],
      },
      looks: {
        enabled: true,
        title: 'Образы',
        categories: [
          { title: 'Весна', text: 'Лёгкие', imageKey: 'home/spring.webp' },
        ],
      },
    },
    navigation: {
      header: [
        { label: 'Каталог', href: '/catalog' },
        { label: 'Доставка', href: '/delivery' },
      ],
      footer: [
        { title: 'Информация', links: [{ label: 'О нас', href: '/about' }] },
      ],
    },
    branding: {
      shopName: 'Шёлк Магазин',
      logoUrl: 'https://cdn/logo.png',
      faviconUrl: null,
      theme: { primaryColor: null, accentColor: null, mode: 'system' },
      supportEmail: null,
      supportPhone: null,
    },
    currency: { code: 'RUB', symbol: '₽', locale: 'ru-RU', fractionDigits: 2 },
    exchange: { displayCurrencies: [], autoRate: false, rateUpdatedAt: null },
    units: { weight: 'g', dimension: 'cm', system: 'metric' },
    contacts: {
      phone: '+7 495 000-00-00',
      email: 'info@shop.ru',
      address: 'Москва',
      workingHours: 'Пн-Пт 9-18',
      socials: [{ type: 'tg', url: 'https://t.me/shop' }],
    },
    legalEntity: {},
    catalog: { newProductDays: 30, masterColors: [] },
    delivery: { freeDeliveryThreshold: 0, zones: [] },
    orders: { orderPrefix: '' },
    seo: {
      site_name: 'Шёлк',
      site_url: 'https://shop.ru',
      title_template: '%s — Шёлк',
      default_description: 'Платки из шёлка',
      noindex_site: false,
    },
  };
}

/** Оверлей переводов EN, повторяющий структуру базовых ключей (только тексты). */
function enOverlay() {
  return {
    en: {
      branding: { shopName: 'Silk Shop' },
      seo: {
        site_name: 'Silk',
        title_template: '%s — Silk',
        default_description: 'Silk scarves',
      },
      contacts: { address: 'Moscow', workingHours: 'Mon-Fri 9-18' },
      home: {
        hero: { title: 'Silk', subtitle: 'Scarves', ctaLabel: 'Shop now' },
        about: { title: 'About', paragraphs: ['First', 'Second'], values: ['Quality', 'Service'] },
        looks: { title: 'Looks', categories: [{ title: 'Spring', text: 'Light' }] },
      },
      navigation: {
        header: [{ label: 'Catalog' }, { label: 'Delivery' }],
        footer: [{ title: 'Info', links: [{ label: 'About us' }] }],
      },
    },
  };
}

const EN = { locale: 'en', defaultLocale: 'ru' };

describe('storefront/settings-dto — локализация через content_i18n', () => {
  it('branding/seo/contacts точечно переведены (только whitelist-поля)', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.branding.shopName).toBe('Silk Shop');
    expect(dto.seo.siteName).toBe('Silk');
    expect(dto.seo.titleTemplate).toBe('%s — Silk');
    expect(dto.seo.defaultDescription).toBe('Silk scarves');
    expect(dto.contacts.address).toBe('Moscow');
    expect(dto.contacts.workingHours).toBe('Mon-Fri 9-18');
  });

  it('НЕпереводимые поля целы: phone/email/socials/logo/siteUrl не тронуты', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.contacts.phone).toBe('+7 495 000-00-00');
    expect(dto.contacts.email).toBe('info@shop.ru');
    expect(dto.contacts.socials).toEqual([{ type: 'tg', url: 'https://t.me/shop' }]);
    expect(dto.branding.logoUrl).toBe('https://cdn/logo.png');
    expect(dto.seo.siteUrl).toBe('https://shop.ru');
  });

  it('home переведён (deep-merge, массивы по индексу), imageKey→URL и href целы', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.home.hero.title).toBe('Silk');
    expect(dto.home.hero.subtitle).toBe('Scarves');
    expect(dto.home.hero.ctaLabel).toBe('Shop now');
    // 🔴 картинка и ссылка НЕ переводятся — резолв ключа в URL произошёл ПОСЛЕ
    // локализации, значит imageKey уцелел и превратился в URL, href остался.
    expect(dto.home.hero.imageUrl).toBe('https://cdn/home/hero.webp');
    expect(dto.home.hero.ctaHref).toBe('/catalog');

    expect(dto.home.about.paragraphs).toEqual(['First', 'Second']);
    expect(dto.home.about.values).toEqual(['Quality', 'Service']);
    // imageKeys → URL целы (перевод их не касается).
    expect(dto.home.about.imageUrls).toEqual([
      'https://cdn/home/a1.webp',
      'https://cdn/home/a2.webp',
    ]);

    // looks.categories: title/text переведены по индексу, imageKey→URL цел.
    expect(dto.home.looks.categories[0]).toEqual({
      title: 'Spring',
      text: 'Light',
      imageUrl: 'https://cdn/home/spring.webp',
    });
  });

  it('navigation переведён (label/title), href целы', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.navigation.header).toEqual([
      { label: 'Catalog', href: '/catalog' },
      { label: 'Delivery', href: '/delivery' },
    ]);
    expect(dto.navigation.footer).toEqual([
      { title: 'Info', links: [{ label: 'About us', href: '/about' }] },
    ]);
  });

  it('перевод отсутствует для языка → база (fallback на defaultLocale)', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay(); // только en
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, {
      locale: 'fr',
      defaultLocale: 'ru',
    });
    expect(dto.branding.shopName).toBe('Шёлк Магазин');
    expect(dto.home.hero.title).toBe('Шёлк');
    expect(dto.navigation.header[0].label).toBe('Каталог');
  });

  it('locale===defaultLocale → no-op (значения базовые, форма DTO не меняется)', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, {
      locale: 'ru',
      defaultLocale: 'ru',
    });
    const base = toPublicSettingsDto(makeEffective(), (k) => `https://cdn/${k}`);
    expect(dto).toEqual(base);
  });

  it('loc не задан → текущее поведение байт-в-байт (обратная совместимость)', () => {
    const eff = makeEffective();
    eff.contentI18n = enOverlay();
    const withOverlayNoLoc = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`);
    const noOverlay = toPublicSettingsDto(makeEffective(), (k) => `https://cdn/${k}`);
    expect(withOverlayNoLoc).toEqual(noOverlay);
  });

  it('битый патч в оверлее не ломает DTO (перевод накладывается безопасно)', () => {
    const eff = makeEffective();
    eff.contentI18n = {
      en: {
        branding: { shopName: 'Silk Shop' },
        home: { about: { paragraphs: 'не-массив' } },
        contacts: 'мусор',
      },
    };
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);
    // Валидное поле переведено...
    expect(dto.branding.shopName).toBe('Silk Shop');
    // ...а битые части не уронили DTO и не затёрли непереводимое.
    expect(dto.contacts.phone).toBe('+7 495 000-00-00');
    expect(Array.isArray(dto.home.about.paragraphs)).toBe(true);
  });

  it('DTO несёт контракт i18n {defaultLocale, locales} для витрины', () => {
    const eff = makeEffective();
    eff.i18n = { defaultLocale: 'ru', locales: ['ru', 'fr'] };
    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`);
    expect(dto.i18n).toEqual({ defaultLocale: 'ru', locales: ['ru', 'fr'] });
  });

  // ---------------------------------------------------------------------------
  // Зоны доставки (ТЗ_1): подпись переводится, деньги — НЕТ.
  // Дефект docs/37 minor №11: покупатель на /fr видел «В пределах МКАД».
  // ---------------------------------------------------------------------------

  it('подпись зоны доставки переводится оверлеем, id/цена остаются базовыми', () => {
    const eff = makeEffective();
    eff.delivery = {
      freeDeliveryThreshold: 0,
      zones: [
        { id: 'mkad', label: 'В пределах МКАД', price: 50000 },
        { id: 'oblast', label: 'За МКАД + область', price: 90000, freeThreshold: 1500000 },
      ],
    };
    eff.contentI18n = {
      en: { delivery: { zones: [{ label: 'Within the MKAD' }, { label: 'Beyond the MKAD + region' }] } },
    };

    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.delivery.zones.map((z) => z.label)).toEqual([
      'Within the MKAD',
      'Beyond the MKAD + region',
    ]);
    // Машинный ключ и деньги не зависят от локали покупателя.
    expect(dto.delivery.zones.map((z) => z.id)).toEqual(['mkad', 'oblast']);
    expect(dto.delivery.zones.map((z) => z.price)).toEqual([50000, 90000]);
    expect(dto.delivery.zones[1].freeThreshold).toBe(1500000);
  });

  it('перевод одной зоны не затирает подпись остальных (массив по индексу)', () => {
    const eff = makeEffective();
    eff.delivery = {
      freeDeliveryThreshold: 0,
      zones: [
        { id: 'mkad', label: 'В пределах МКАД', price: 50000 },
        { id: 'oblast', label: 'За МКАД + область', price: 90000 },
      ],
    };
    // Переведена только ВТОРАЯ зона (дыра в первой позиции — так патч кладёт форма,
    // когда владелец заполнил не все поля).
    eff.contentI18n = { en: { delivery: { zones: [null, { label: 'Beyond the MKAD' }] } } };

    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.delivery.zones[0].label).toBe('В пределах МКАД');
    expect(dto.delivery.zones[1].label).toBe('Beyond the MKAD');
  });

  it('🔴 оверлей НЕ может подменить цену зоны: деньги берутся только из базы', () => {
    const eff = makeEffective();
    eff.delivery = {
      freeDeliveryThreshold: 0,
      zones: [{ id: 'mkad', label: 'В пределах МКАД', price: 50000, freeThreshold: 1000000 }],
    };
    // Враждебный/ошибочный патч пытается принести деньги и чужой id.
    eff.contentI18n = {
      en: {
        delivery: {
          zones: [{ label: 'Within the MKAD', price: 1, freeThreshold: 1, id: 'hacked' }],
        },
      },
    };

    const dto = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, EN);

    expect(dto.delivery.zones[0].label).toBe('Within the MKAD');
    expect(dto.delivery.zones[0].price).toBe(50000);
    expect(dto.delivery.zones[0].freeThreshold).toBe(1000000);
    expect(dto.delivery.zones[0].id).toBe('mkad');
  });

  it('без оверлея и на базовой локали подписи зон остаются базовыми', () => {
    const eff = makeEffective();
    eff.delivery = {
      freeDeliveryThreshold: 0,
      zones: [{ id: 'mkad', label: 'В пределах МКАД', price: 50000 }],
    };
    const noLoc = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`);
    expect(noLoc.delivery.zones[0].label).toBe('В пределах МКАД');

    eff.contentI18n = { en: { delivery: { zones: [{ label: 'Within the MKAD' }] } } };
    const ru = toPublicSettingsDto(eff, (k) => `https://cdn/${k}`, {
      locale: 'ru',
      defaultLocale: 'ru',
    });
    expect(ru.delivery.zones[0].label).toBe('В пределах МКАД');
  });
});
