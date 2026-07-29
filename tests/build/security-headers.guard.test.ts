import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: базовые заголовки безопасности выставлены на обоих приложениях.
 *
 * ЖИВАЯ ПРОВЕРКА 2026-07-29 (стенд erfgv.website) показала два пробела:
 *   1) `Content-Security-Policy` не отдавался НИ витриной, ни админкой. HSTS,
 *      nosniff, X-Frame-Options и Referrer-Policy были, CSP — нет. Для админки
 *      с сессионной кукой и витрины с оплатой это главный невыставленный барьер
 *      против XSS.
 *   2) Админка отдавала `x-powered-by: Next.js` (витрина — нет), раскрывая стек.
 *
 * Почему CSP задаётся в Caddy, а не в Next: заголовок общий для статики и
 * страниц, и держать его в одном месте рядом с остальными (`security_headers`)
 * честнее, чем расщеплять между прокси и двумя приложениями.
 */
describe('GUARD: заголовки безопасности', () => {
  const root = process.cwd();
  const caddyfile = readFileSync(join(root, 'Caddyfile'), 'utf8');

  it('Caddy отдаёт Content-Security-Policy', () => {
    const block = caddyfile.slice(
      caddyfile.indexOf('(security_headers)'),
      caddyfile.indexOf('(security_headers)') + 1600,
    );
    expect(block).toMatch(/Content-Security-Policy/i);
  });

  it('CSP запрещает объекты и ограничивает базовый URI и фреймы-предки', () => {
    const block = caddyfile.slice(
      caddyfile.indexOf('(security_headers)'),
      caddyfile.indexOf('(security_headers)') + 1600,
    );
    // default-src — фундамент политики; без него директивы не наследуются.
    expect(block).toMatch(/default-src/);
    // object-src 'none' убирает легаси-вектор через <object>/<embed>.
    expect(block).toMatch(/object-src\s+'none'/);
    // base-uri ограничивает подмену <base> (увод относительных ссылок).
    expect(block).toMatch(/base-uri/);
    // frame-ancestors — CSP-версия X-Frame-Options, её и уважают браузеры.
    expect(block).toMatch(/frame-ancestors/);
  });

  it('прежние заголовки не потеряны при добавлении CSP', () => {
    const block = caddyfile.slice(
      caddyfile.indexOf('(security_headers)'),
      caddyfile.indexOf('(security_headers)') + 1600,
    );
    expect(block).toMatch(/Strict-Transport-Security/);
    expect(block).toMatch(/X-Content-Type-Options/);
    expect(block).toMatch(/X-Frame-Options/);
    expect(block).toMatch(/Referrer-Policy/);
  });

  it.each([
    ['next.config.mjs', 'админка'],
    ['storefront/next.config.mjs', 'витрина'],
  ])('%s (%s) не раскрывает стек через x-powered-by', (path) => {
    const cfg = readFileSync(join(root, path), 'utf8');
    expect(cfg).toMatch(/poweredByHeader:\s*false/);
  });
});
