import { describe, expect, it } from 'vitest';

import { storefrontFallback, withParam } from '@/app/mock/tbank/pay/page';

/**
 * Баг #20 (аудит тупиков): demo-страница оплаты Т-Банк при returnUrl ВНЕ
 * allowlist молча редиректила на '/' — корень Admik, тупик для покупателя.
 * Теперь fallback ведёт на ПЕРВЫЙ доверенный origin витрины (allowed[0]) —
 * не тупиковый корень Admik, и без open-redirect (returnUrl из query не доверяем).
 * Пустой allowlist (demo без секретов) — поведение прежнее.
 */

const ALLOWED = ['https://shop.example', 'https://www.shop.example'];

describe('mock tbank pay — storefrontFallback (баг #20)', () => {
  it('пустой allowlist → "/" (demo-режим без секретов)', () => {
    expect(storefrontFallback([])).toBe('/');
  });

  it('непустой allowlist → первый доверенный origin витрины (не корень Admik)', () => {
    expect(storefrontFallback(ALLOWED)).toBe('https://shop.example');
  });
});

describe('mock tbank pay — withParam (анти-open-redirect + не-тупиковый fallback)', () => {
  it('origin В allowlist → добавляет query к returnUrl', () => {
    expect(withParam('https://shop.example/account', 'paid', '1', ALLOWED)).toBe(
      'https://shop.example/account?paid=1',
    );
  });

  it('origin ВНЕ allowlist → fallback на доверенный origin, НЕ "/"', () => {
    expect(withParam('https://evil.test/x', 'paid', '1', ALLOWED)).toBe('https://shop.example');
  });

  it('битый URL → доверенный fallback', () => {
    expect(withParam('не url', 'paid', '1', ALLOWED)).toBe('https://shop.example');
  });

  it('не-http(s) протокол → доверенный fallback (анти-open-redirect)', () => {
    expect(withParam('javascript:alert(1)', 'paid', '1', ALLOWED)).toBe('https://shop.example');
  });

  it('пустой allowlist (demo) → возврат на returnUrl без проверки', () => {
    expect(withParam('https://any.test/r', 'paid', '1', [])).toBe('https://any.test/r?paid=1');
  });
});
