import { describe, it, expect, afterEach, vi } from 'vitest';

import type { EffectiveSettings } from '@/lib/config/settings';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * АУДИТ major №20 (роут): GET /api/storefront/v1/settings обязан отдавать
 * `delivery.methods` — ДОСТУПНЫЕ СПОСОБЫ доставки, посчитанные по АВТОРИТЕТНОМУ
 * рантайм-гейту модулей (env ⊕ module_overrides), тем же, что гейтит роуты
 * /delivery/cdek/*. Иначе витрина предлагает СДЭК, а роуты отвечают 404.
 *
 * Внутреннее устройство наружу по-прежнему не раскрывается: module_overrides и
 * имена модулей платформы в теле ответа отсутствуют.
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

function fakeEffective(): EffectiveSettings {
  return {
    modules: { overrides: {} },
    access: { singleUserMode: false },
    home: HOME_DEFAULTS,
    navigation: { header: [], footer: [] },
    contentI18n: {},
    i18n: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
    branding: {
      shopName: 'Demo Shop',
      logoUrl: null,
      faviconUrl: null,
      theme: { primaryColor: null, accentColor: null, mode: 'system' },
      supportEmail: null,
      supportPhone: null,
    },
    currency: { code: 'RUB', symbol: null, locale: null, fractionDigits: 2 },
    exchange: { displayCurrencies: [], autoRate: false, rateUpdatedAt: null },
    units: { weight: 'g', dimension: 'cm', system: 'metric' },
    contacts: {},
    legalEntity: { bankDetails: 'SECRET-BANK-DETAILS' },
    catalog: { newProductDays: 30, masterColors: [] },
    delivery: {
      freeDeliveryThreshold: 0,
      zones: [{ id: 'z1', label: 'Зона', price: 30000, freeThreshold: null }],
    },
    orders: { orderPrefix: '' },
    seo: { title_template: '%s', noindex_site: false },
  } as unknown as EffectiveSettings;
}

/** Роут с подменённым авторитетным гейтом модулей (без БД). */
async function loadRoute(enabledModules: string[]) {
  vi.resetModules();
  vi.doMock('@/lib/config/settings', () => ({
    getEffectiveSettings: vi.fn(async () => fakeEffective()),
    getEffectiveModuleSet: vi.fn(async () => new Set(enabledModules)),
    isModuleEffectivelyEnabled: vi.fn(async (m: string) => enabledModules.includes(m)),
  }));
  vi.doMock('@/lib/settings/repository', () => ({
    getSetting: vi.fn(async () => ({
      value: { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] },
    })),
  }));
  return import('@/app/api/storefront/v1/settings/route');
}

async function fetchDto(enabledModules: string[]) {
  process.env.STOREFRONT_API_KEYS = 'sk_secret';
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  const { GET } = await loadRoute(enabledModules);
  const res = await GET(
    new Request('http://x/api/storefront/v1/settings', {
      headers: { 'x-storefront-key': 'sk_secret' },
    }),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, data: (JSON.parse(text) as { data: Record<string, unknown> }).data };
}

describe('GET /settings — delivery.methods по авторитетному гейту модулей', () => {
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
    vi.doUnmock('@/lib/config/settings');
    vi.doUnmock('@/lib/settings/repository');
    vi.resetModules();
  });

  it('cdek включён → methods содержит cdek_courier и cdek_pvz', async () => {
    const { data } = await fetchDto(['catalog', 'orders', 'cdek']);
    const delivery = data.delivery as { methods: string[] };
    expect(delivery.methods).toContain('cdek_courier');
    expect(delivery.methods).toContain('cdek_pvz');
    expect(delivery.methods).toContain('zone');
  });

  it('cdek ВЫКЛЮЧЕН → методов СДЭК в ответе нет (витрина их не предложит)', async () => {
    const { data } = await fetchDto(['catalog', 'orders']);
    const delivery = data.delivery as { methods: string[] };
    expect(delivery.methods).toEqual(['zone']);
  });

  it('тело ответа не раскрывает module_overrides и набор модулей платформы', async () => {
    const { text } = await fetchDto(['catalog']);
    expect(text).not.toContain('module_overrides');
    expect(text).not.toContain('"modules"');
    expect(text).not.toContain('cdekEnabled');
  });
});
