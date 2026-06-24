import { describe, it, expect } from 'vitest';
import {
  parseApiKeys,
  parseAllowedOrigins,
  normalizeOrigin,
  getStorefrontConfig,
} from '@/lib/storefront/env';

describe('storefront/env — parseApiKeys', () => {
  it('пустой ввод → []', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
    expect(parseApiKeys('   ')).toEqual([]);
  });

  it('простые ключи через запятую', () => {
    expect(parseApiKeys('sk_a, sk_b ,sk_c')).toEqual([
      { key: 'sk_a' },
      { key: 'sk_b' },
      { key: 'sk_c' },
    ]);
  });

  it('форма «домен:ключ» разбирается по первому двоеточию', () => {
    expect(parseApiKeys('shop.example.com:sk_xyz')).toEqual([
      { key: 'sk_xyz', domain: 'shop.example.com' },
    ]);
  });

  it('ключ с двоеточиями внутри сохраняется целиком', () => {
    expect(parseApiKeys('d.com:sk:with:colons')).toEqual([
      { key: 'sk:with:colons', domain: 'd.com' },
    ]);
  });
});

describe('storefront/env — origins', () => {
  it('нормализует Origin к scheme://host[:port], нижний регистр', () => {
    expect(normalizeOrigin('https://Shop.Example.com')).toBe(
      'https://shop.example.com',
    );
    expect(normalizeOrigin('http://localhost:3000/path')).toBe(
      'http://localhost:3000',
    );
  });

  it('пустой/невалидный Origin', () => {
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });

  it('parseAllowedOrigins нормализует список', () => {
    expect(
      parseAllowedOrigins('https://A.com, http://localhost:3000 '),
    ).toEqual(['https://a.com', 'http://localhost:3000']);
  });
});

describe('storefront/env — getStorefrontConfig', () => {
  it('читает из переданного источника', () => {
    const cfg = getStorefrontConfig({
      STOREFRONT_API_KEYS: 'sk_1',
      STOREFRONT_ALLOWED_ORIGINS: 'https://x.com',
    });
    expect(cfg.apiKeys).toEqual([{ key: 'sk_1' }]);
    expect(cfg.allowedOrigins).toEqual(['https://x.com']);
  });

  it('пустой источник → пустая конфигурация (mock)', () => {
    const cfg = getStorefrontConfig({});
    expect(cfg.apiKeys).toEqual([]);
    expect(cfg.allowedOrigins).toEqual([]);
  });
});
