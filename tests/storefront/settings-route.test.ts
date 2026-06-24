import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { EffectiveSettings } from '@/lib/config/settings';
import { HOME_DEFAULTS } from '@/lib/config/home-defaults';

/**
 * Тесты пакета 5.D-2 (docs/11 §5.4.6) — роут GET /api/storefront/v1/settings.
 *
 * core-always-on: отдаётся независимо от ADMIK_MODULES (в т.ч. без cms/без catalog).
 * Мокаем getEffectiveSettings (без БД) — проверяем DTO + CORS + OPTIONS preflight.
 */

const ORIGINAL_MODULES = process.env.ADMIK_MODULES;
const ORIGINAL_KEYS = process.env.STOREFRONT_API_KEYS;
const ORIGINAL_ORIGINS = process.env.STOREFRONT_ALLOWED_ORIGINS;

function fakeEffective(): EffectiveSettings {
  return {
    modules: { overrides: {} },
    home: HOME_DEFAULTS,
    navigation: { header: [], footer: [] },
    branding: {
      shopName: 'Demo Shop',
      logoUrl: null,
      faviconUrl: null,
      theme: { primaryColor: null, accentColor: null, mode: 'system' },
      supportEmail: null,
      supportPhone: null,
    },
    currency: { code: 'RUB', symbol: null, locale: null, fractionDigits: 2 },
    units: { weight: 'g', dimension: 'cm', system: 'metric' },
    contacts: {},
    legalEntity: { bankDetails: 'SECRET-BANK-DETAILS' },
    catalog: { newProductDays: 30 },
    delivery: { freeDeliveryThreshold: 0 },
    orders: { orderPrefix: '' },
    seo: {
      title_template: '%s',
      noindex_site: false,
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/config/settings', () => ({
    getEffectiveSettings: vi.fn(async () => fakeEffective()),
  }));
  return import('@/app/api/storefront/v1/settings/route');
}

describe('GET /api/storefront/v1/settings — core-always-on', () => {
  beforeEach(() => {
    process.env.STOREFRONT_API_KEYS = 'sk_secret';
    process.env.STOREFRONT_ALLOWED_ORIGINS = '';
  });
  afterEach(() => {
    process.env.ADMIK_MODULES = ORIGINAL_MODULES;
    process.env.STOREFRONT_API_KEYS = ORIGINAL_KEYS;
    process.env.STOREFRONT_ALLOWED_ORIGINS = ORIGINAL_ORIGINS;
    vi.doUnmock('@/lib/config/settings');
    vi.resetModules();
  });

  it('отдаётся при ADMIK_MODULES без cms (только catalog) — 200 + DTO', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await loadRoute();
    const req = new Request('http://x/api/storefront/v1/settings', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    const body = (await res.json()) as { data: { branding: { shopName: string } } };
    expect(body.data.branding.shopName).toBe('Demo Shop');
  });

  it('отдаётся даже при пустом наборе модулей (core-always-on)', async () => {
    process.env.ADMIK_MODULES = ''; // ни одного feature-модуля
    const { GET } = await loadRoute();
    const req = new Request('http://x/api/storefront/v1/settings', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('DTO не содержит bankDetails', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await loadRoute();
    const req = new Request('http://x/api/storefront/v1/settings', {
      headers: { 'x-storefront-key': 'sk_secret' },
    });
    const res = await GET(req);
    const text = await res.text();
    expect(text).not.toContain('SECRET-BANK-DETAILS');
  });

  it('без ключа/origin → 401 unauthorized', async () => {
    process.env.ADMIK_MODULES = 'catalog';
    const { GET } = await loadRoute();
    const res = await GET(new Request('http://x/api/storefront/v1/settings'));
    expect(res.status).toBe(401);
  });

  it('OPTIONS → 204 preflight', async () => {
    const { OPTIONS } = await loadRoute();
    const req = new Request('http://x/api/storefront/v1/settings', {
      method: 'OPTIONS',
      headers: { origin: 'https://demo.com', 'access-control-request-method': 'GET' },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
  });
});
