import { describe, it, expect } from 'vitest';

import { toPublicSettingsDto } from '@/lib/storefront/settings-dto';
import type { EffectiveSettings } from '@/lib/config/settings';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * АУДИТ major №20 — при выключенном модуле `cdek` витрина продолжала предлагать
 * «Курьер СДЭК» / «Пункт выдачи СДЭК»: радио рисовались БЕЗУСЛОВНО, потому что
 * публичный DTO настроек ничего не сообщал о доступности СДЭК. Покупатель выбирал
 * ПВЗ → роуты /delivery/cdek/* под module-gate отдавали 404 → списки пустые →
 * оформить нельзя без объяснения.
 *
 * КОНТРАКТ (осознанно НЕ «состояние модулей»): DTO отдаёт ВОЗМОЖНОСТИ —
 * `delivery.methods` — список доступных способов доставки. Внутреннее устройство
 * (module_overrides / имена модулей платформы) наружу по-прежнему не раскрывается.
 */

function makeEffective(): EffectiveSettings {
  return {
    modules: { overrides: {} },
    home: HOME_DEFAULTS,
    navigation: { header: [], footer: [] },
    access: { singleUserMode: false },
    contentI18n: {},
    i18n: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
    branding: {
      shopName: 'Any Shop',
      logoUrl: null,
      faviconUrl: null,
      theme: { primaryColor: null, accentColor: null, mode: 'system' },
      supportEmail: null,
      supportPhone: null,
    },
    currency: { code: 'RUB', symbol: '₽', locale: 'ru-RU', fractionDigits: 2 },
    exchange: { displayCurrencies: [], autoRate: false, rateUpdatedAt: null },
    units: { weight: 'kg', dimension: 'cm', system: 'metric' },
    contacts: {},
    legalEntity: { bankDetails: 'SECRET' },
    catalog: { newProductDays: 30, masterColors: [] },
    delivery: {
      freeDeliveryThreshold: 0,
      zones: [{ id: 'z1', label: 'В пределах МКАД', price: 50000, freeThreshold: null }],
    },
    orders: { orderPrefix: '' },
    seo: { title_template: '%s', noindex_site: false },
  } as unknown as EffectiveSettings;
}

describe('PublicSettingsDto.delivery.methods — возможности, а не модули', () => {
  it('модуль cdek ВКЛЮЧЁН → доступны зона + курьер СДЭК + ПВЗ СДЭК', () => {
    const dto = toPublicSettingsDto(makeEffective(), (k) => k, undefined, {
      cdekEnabled: true,
    });
    expect(dto.delivery.methods).toEqual(['zone', 'cdek_courier', 'cdek_pvz']);
  });

  it('модуль cdek ВЫКЛЮЧЕН → в methods нет ни одного cdek-способа', () => {
    const dto = toPublicSettingsDto(makeEffective(), (k) => k, undefined, {
      cdekEnabled: false,
    });
    expect(dto.delivery.methods).toEqual(['zone']);
    expect(dto.delivery.methods).not.toContain('cdek_courier');
    expect(dto.delivery.methods).not.toContain('cdek_pvz');
  });

  it('зон нет и cdek выключен → methods пуст (магазин без онлайн-доставки — валидная конфигурация)', () => {
    const eff = makeEffective();
    eff.delivery.zones = [];
    const dto = toPublicSettingsDto(eff, (k) => k, undefined, { cdekEnabled: false });
    expect(dto.delivery.methods).toEqual([]);
  });

  it('зон нет, cdek включён → только cdek-способы', () => {
    const eff = makeEffective();
    eff.delivery.zones = [];
    const dto = toPublicSettingsDto(eff, (k) => k, undefined, { cdekEnabled: true });
    expect(dto.delivery.methods).toEqual(['cdek_courier', 'cdek_pvz']);
  });

  it('обратная совместимость: без 4-го аргумента способы СДЭК доступны (прежнее поведение)', () => {
    const dto = toPublicSettingsDto(makeEffective());
    expect(dto.delivery.methods).toContain('cdek_courier');
    expect(dto.delivery.methods).toContain('cdek_pvz');
  });

  it('внутреннее устройство наружу НЕ раскрыто: ни module_overrides, ни имён модулей', () => {
    const dto = toPublicSettingsDto(makeEffective(), (k) => k, undefined, {
      cdekEnabled: false,
    });
    const json = JSON.stringify(dto);
    expect(json).not.toContain('module_overrides');
    expect(json).not.toContain('modules');
    expect(dto).not.toHaveProperty('modules');
    // «cdek» встречается ТОЛЬКО как имя способа доставки, не как флаг модуля.
    expect(dto).not.toHaveProperty('delivery.cdekEnabled');
    expect(json).not.toContain('cdekEnabled');
  });
});
