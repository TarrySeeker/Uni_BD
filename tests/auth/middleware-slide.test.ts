import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '@/lib/auth/constants';

/**
 * m8: middleware переустанавливает cookie сессии со свежим сроком (скользящее окно),
 * иначе серверное продление сессии в БД (validateSession) не доходит до браузера и
 * активный пользователь «разлогинивается» в login-time + TTL. Только на GET-навигациях
 * (на POST/server-action не трогаем — иначе перебили бы очистку cookie при логауте).
 */

function req(path: string, opts: { cookie?: string; method?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new NextRequest(new URL(path, 'http://localhost'), {
    method: opts.method ?? 'GET',
    headers,
  });
}

describe('middleware — скользящее окно cookie (m8)', () => {
  it('аутентифицированный GET /admin/* → cookie переустановлена с maxAge=TTL', () => {
    const res = middleware(req('/admin/dashboard', { cookie: `${SESSION_COOKIE_NAME}=abc` }));
    const c = res.cookies.get(SESSION_COOKIE_NAME);
    expect(c?.value).toBe('abc');
    expect(c?.maxAge).toBe(Math.floor(SESSION_TTL_MS / 1000));
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe('lax');
    expect(c?.path).toBe('/');
  });

  it('/admin/login → cookie НЕ переустанавливается (публичный путь)', () => {
    const res = middleware(req('/admin/login', { cookie: `${SESSION_COOKIE_NAME}=abc` }));
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('POST (server action) → cookie НЕ переустанавливается (логаут не перебивается)', () => {
    const res = middleware(
      req('/admin/dashboard', { cookie: `${SESSION_COOKIE_NAME}=abc`, method: 'POST' }),
    );
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('без сессии → редирект на /admin/login, cookie не ставится', () => {
    const res = middleware(req('/admin/dashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/admin/login');
    expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });
});
