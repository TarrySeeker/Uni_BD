import { describe, it, expect } from 'vitest';
import {
  buildCorsHeaders,
  buildPreflightHeaders,
  isPreflight,
  STOREFRONT_METHODS,
  STOREFRONT_ALLOWED_HEADERS,
} from '@/lib/storefront/cors';

describe('storefront/cors — buildCorsHeaders', () => {
  it('для конкретного origin эхо + Vary: Origin', () => {
    const h = buildCorsHeaders('https://shop.com');
    expect(h['Access-Control-Allow-Origin']).toBe('https://shop.com');
    expect(h['Access-Control-Allow-Methods']).toBe(STOREFRONT_METHODS);
    expect(h['Access-Control-Allow-Headers']).toBe(STOREFRONT_ALLOWED_HEADERS);
    expect(h.Vary).toBe('Origin');
  });

  it('без origin → «*» без Vary', () => {
    const h = buildCorsHeaders(null);
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h.Vary).toBeUndefined();
  });
});

describe('storefront/cors — preflight', () => {
  it('preflight-заголовки содержат Max-Age', () => {
    const h = buildPreflightHeaders('https://shop.com');
    expect(h['Access-Control-Max-Age']).toBe('600');
    expect(h['Access-Control-Allow-Origin']).toBe('https://shop.com');
  });

  it('isPreflight: OPTIONS + Access-Control-Request-Method', () => {
    const pre = new Headers({ 'access-control-request-method': 'GET' });
    expect(isPreflight('OPTIONS', pre)).toBe(true);
    expect(isPreflight('options', pre)).toBe(true);
    expect(isPreflight('GET', pre)).toBe(false);
    expect(isPreflight('OPTIONS', new Headers({}))).toBe(false);
  });
});
