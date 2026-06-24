import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  authorizeStorefront,
  extractApiKey,
  resetStorefrontAuthWarn,
} from '@/lib/storefront/auth';
import type { StorefrontConfig } from '@/lib/storefront/env';

/** Хелпер: Headers из объекта (case-insensitive как настоящий Headers). */
function headers(obj: Record<string, string>): Headers {
  return new Headers(obj);
}

const withKeys: StorefrontConfig = {
  apiKeys: [{ key: 'sk_secret', domain: 'shop.com' }],
  allowedOrigins: [],
};
const withOrigins: StorefrontConfig = {
  apiKeys: [],
  allowedOrigins: ['https://shop.com'],
};
const empty: StorefrontConfig = { apiKeys: [], allowedOrigins: [] };

describe('storefront/auth — extractApiKey', () => {
  it('берёт ключ из X-Storefront-Key или X-Api-Key', () => {
    expect(extractApiKey(headers({ 'x-storefront-key': 'a' }))).toBe('a');
    expect(extractApiKey(headers({ 'x-api-key': 'b' }))).toBe('b');
    expect(extractApiKey(headers({}))).toBeNull();
  });
});

describe('storefront/auth — authorizeStorefront по ключу', () => {
  it('валидный ключ → ok', () => {
    const res = authorizeStorefront(
      headers({ 'x-storefront-key': 'sk_secret' }),
      withKeys,
    );
    expect(res.ok).toBe(true);
    expect(res.via).toBe('key');
  });

  it('неверный ключ → !ok', () => {
    const res = authorizeStorefront(
      headers({ 'x-storefront-key': 'wrong' }),
      withKeys,
    );
    expect(res.ok).toBe(false);
  });

  it('без ключа → !ok', () => {
    expect(authorizeStorefront(headers({}), withKeys).ok).toBe(false);
  });

  it('совпадает любой из нескольких настроенных ключей (без раннего выхода)', () => {
    const multi: StorefrontConfig = {
      apiKeys: [
        { key: 'sk_first', domain: 'a.com' },
        { key: 'sk_second', domain: 'b.com' },
      ],
      allowedOrigins: [],
    };
    // Совпадает первый.
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'sk_first' }), multi).ok,
    ).toBe(true);
    // Совпадает второй (проверка проходит по всем ключам).
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'sk_second' }), multi).ok,
    ).toBe(true);
    // Не совпадает ни один.
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'sk_none' }), multi).ok,
    ).toBe(false);
  });

  it('ключ другой длины → !ok (constant-time сравнение не падает)', () => {
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'x' }), withKeys).ok,
    ).toBe(false);
  });

  it('m9: неверный ключ ТОЙ ЖЕ длины → !ok (точное сравнение, не только длина)', () => {
    // 'sk_secret' (9 симв.) vs 'sk_secre7' (9 симв.) — длины равны, но ключ другой.
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'sk_secre7' }), withKeys).ok,
    ).toBe(false);
    // Префикс валидного ключа тоже не проходит.
    expect(
      authorizeStorefront(headers({ 'x-storefront-key': 'sk_secre' }), withKeys).ok,
    ).toBe(false);
  });
});

describe('storefront/auth — authorizeStorefront по Origin', () => {
  it('разрешённый Origin → ok + возвращает нормализованный origin', () => {
    const res = authorizeStorefront(
      headers({ origin: 'https://Shop.com' }),
      withOrigins,
    );
    expect(res.ok).toBe(true);
    expect(res.via).toBe('origin');
    expect(res.origin).toBe('https://shop.com');
  });

  it('чужой Origin → !ok', () => {
    const res = authorizeStorefront(
      headers({ origin: 'https://evil.com' }),
      withOrigins,
    );
    expect(res.ok).toBe(false);
  });
});

describe('storefront/auth — mock-режим', () => {
  beforeEach(() => resetStorefrontAuthWarn());

  it('пустая конфигурация → ok + mock + одноразовый warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r1 = authorizeStorefront(headers({ origin: 'https://any.com' }), empty);
    const r2 = authorizeStorefront(headers({}), empty);
    expect(r1.ok).toBe(true);
    expect(r1.mock).toBe(true);
    expect(r1.via).toBe('mock');
    expect(r1.origin).toBe('https://any.com');
    expect(r2.ok).toBe(true);
    // warn ровно один раз на оба вызова.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
