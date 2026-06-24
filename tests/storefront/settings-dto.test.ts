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
