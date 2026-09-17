import { describe, it, expect } from 'vitest';

import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import type { EffectiveSettings } from '@/lib/config/settings';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты пакета 5.D-2 (docs/11 §5.4.6) — публичный DTO настроек.
 * DTO-изоляция (§7): наружу только публичные поля; bankDetails/updated_by/
 * приватные SEO-ключи (og_image_key)/module_overrides НЕ утекают.
 */

function makeEffective(): EffectiveSettings {
  return {
    modules: { overrides: {} },
    home: HOME_DEFAULTS,
    navigation: { header: [], footer: [] },
    access: { singleUserMode: false },
    // Платформенный дефолт size_charts: сеток нет (таблица размеров не рисуется).
    sizeCharts: { charts: [] },
    // Платформенные дефолты режима оформления: оплата включена (иначе появление
    // настройки молча выключило бы приём денег), упаковка выключена.
    checkout: {
      onlinePaymentEnabled: true,
      paymentDisabledNotice: null,
      giftWrapEnabled: false,
      giftWrapLabel: null,
    },
    branding: {
      shopName: 'Gang Auto',
      logoUrl: 'https://cdn/logo.png',
      faviconUrl: null,
      theme: { primaryColor: '#ff0000', accentColor: null, mode: 'light' },
      supportEmail: 'help@ga.ru',
      supportPhone: '+7 999 000-00-00',
    },
    currency: { code: 'RUB', symbol: '₽', locale: 'ru-RU', fractionDigits: 2 },
    units: { weight: 'kg', dimension: 'cm', system: 'metric' },
    contacts: {
      phone: '+7 495 000-00-00',
      email: 'info@ga.ru',
      address: 'Москва',
      workingHours: '9-18',
      socials: [{ type: 'tg', url: 'https://t.me/ga' }],
    },
    legalEntity: {
      name: 'ООО ГА',
      inn: '7701234567',
      kpp: '770101001',
      ogrn: '1027700000000',
      legalAddress: 'Москва, ул. ...',
      bankDetails: 'р/с 40702810000000000000, БИК 044525225',
    },
    catalog: { newProductDays: 30 },
    delivery: { freeDeliveryThreshold: 300000 },
    orders: { orderPrefix: 'GA' },
    seo: {
      site_name: 'Gang Auto',
      site_url: 'https://gangauto.ru',
      title_template: '%s — Gang Auto',
      default_description: 'Запчасти',
      default_og_image_key: 'seo/og-default.png',
      robots_extra: 'Disallow: /tmp',
      twitter_site: '@ga',
      noindex_site: false,
    },
  };
}

describe('storefront/settings-dto — toPublicSettingsDto', () => {
  it('НЕ содержит bankDetails', () => {
    const dto = toPublicSettingsDto(makeEffective());
    expect((dto.legalEntity as Record<string, unknown>).bankDetails).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain('40702810');
  });

  it('НЕ содержит приватный SEO-ключ og_image_key и robots_extra/noindex_site', () => {
    const dto = toPublicSettingsDto(makeEffective());
    const json = JSON.stringify(dto);
    expect(json).not.toContain('og-default.png');
    expect(json).not.toContain('default_og_image_key');
    expect(json).not.toContain('robots_extra');
    expect(json).not.toContain('noindex_site');
  });

  it('НЕ содержит updated_by/updated_at/module_overrides', () => {
    const json = JSON.stringify(toPublicSettingsDto(makeEffective()));
    expect(json).not.toContain('updated_by');
    expect(json).not.toContain('updated_at');
    expect(json).not.toContain('module_overrides');
  });

  it('содержит публичные поля брендинга/валюты/контактов/реквизитов/доставки/seo', () => {
    const dto = toPublicSettingsDto(makeEffective());
    expect(dto.branding.shopName).toBe('Gang Auto');
    expect(dto.branding.theme.primaryColor).toBe('#ff0000');
    expect(dto.currency.code).toBe('RUB');
    expect(dto.units.weight).toBe('kg');
    expect(dto.contacts.socials).toEqual([{ type: 'tg', url: 'https://t.me/ga' }]);
    expect(dto.legalEntity.inn).toBe('7701234567');
    expect(dto.legalEntity.name).toBe('ООО ГА');
    // деньги — в копейках.
    expect(dto.delivery.freeDeliveryThreshold).toBe(300000);
    expect(dto.seo.titleTemplate).toBe('%s — Gang Auto');
    expect(dto.seo.siteUrl).toBe('https://gangauto.ru');
  });

  it('пустые контакты/реквизиты → null/[] (без undefined-полей)', () => {
    const eff = makeEffective();
    eff.contacts = {};
    eff.legalEntity = {};
    const dto = toPublicSettingsDto(eff);
    expect(dto.contacts.phone).toBeNull();
    expect(dto.contacts.socials).toEqual([]);
    expect(dto.legalEntity.name).toBeNull();
  });
});

/**
 * Режим оформления заказа в публичном DTO.
 *
 * 🔴 ГЛАВНОЕ СВОЙСТВО: онлайн-оплата показывается витрине ТОЛЬКО когда
 * совпало ДВА условия — бизнес-тумблер владельца И включённый модуль
 * payments. Каждое по отдельности недостаточно:
 *   • тумблер включён, модуль выключен → витрина нарисует кнопку оплаты, а
 *     createOrder отклонит заказ с payments_disabled. Покупатель увидит
 *     ошибку на последнем шаге — худший момент из возможных;
 *   • модуль включён, тумблер выключен → владелец сознательно не берёт
 *     деньги на сайте (эквайринг не подключён, документы не готовы), и
 *     показывать оплату нельзя.
 */
describe('settings DTO — checkout: оплата только при тумблере И модуле', () => {
  const eff = () => ({
    ...makeEffective(),
    checkout: {
      onlinePaymentEnabled: true,
      paymentDisabledNotice: 'Оплата при получении',
      giftWrapEnabled: true,
      giftWrapLabel: 'Подарочная упаковка',
    },
  });

  it('тумблер включён + модуль включён → оплата доступна', () => {
    const dto = toPublicSettingsDto(eff(), (k) => k, true);
    expect(dto.checkout.onlinePaymentEnabled).toBe(true);
  });

  it('🔴 тумблер включён, но модуль payments ВЫКЛЮЧЕН → оплата НЕ доступна', () => {
    const dto = toPublicSettingsDto(eff(), (k) => k, false);
    expect(dto.checkout.onlinePaymentEnabled).toBe(false);
  });

  it('🔴 тумблер выключен → оплата не доступна даже при включённом модуле', () => {
    const src = eff();
    src.checkout.onlinePaymentEnabled = false;
    const dto = toPublicSettingsDto(src, (k) => k, true);
    expect(dto.checkout.onlinePaymentEnabled).toBe(false);
  });

  it('текст-заглушка и подарочная упаковка проходят наружу как есть', () => {
    const dto = toPublicSettingsDto(eff(), (k) => k, false);
    expect(dto.checkout.paymentDisabledNotice).toBe('Оплата при получении');
    expect(dto.checkout.giftWrapEnabled).toBe(true);
    expect(dto.checkout.giftWrapLabel).toBe('Подарочная упаковка');
  });

  /**
   * Обратная совместимость: параметр не передан → считаем модуль включённым,
   * то есть поведение до появления флага. Иначе все существующие вызовы
   * молча погасили бы оплату.
   */
  it('параметр модуля не передан → прежнее поведение (оплата по тумблеру)', () => {
    const dto = toPublicSettingsDto(eff(), (k) => k);
    expect(dto.checkout.onlinePaymentEnabled).toBe(true);
  });
});
