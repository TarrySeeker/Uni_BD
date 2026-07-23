import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD витрины (storefront/ исключён из tsconfig/eslint корня и не покрыт
 * React-тестами — environment 'node'). Сторожим СУТЬ, а не подстроки:
 *  - страница успеха действительно монтирует блок кода и отдаёт ему токен;
 *  - блок КЛИЕНТСКИЙ и не тянет серверные модули (границу «клиент→сервер» в
 *    storefront/ общий guard tests/build/* не обходит — этот дир он пропускает);
 *  - код запрашивается ОТДЕЛЬНЫМ эндпоинтом /gift-codes по ?token=, а не берётся
 *    из DTO заказа, и ответ не кешируется;
 *  - опрос ограничен (5 c × 24 ≈ 2 минуты) и завершается внятным текстом;
 *  - словари: ЛОЖНОГО обещания «мы отправили детали на вашу почту» больше нет
 *    (модуля отправки email в платформе не существует), а строки блока есть во
 *    всех трёх языках и являются строками, а не функциями (функции ломают
 *    prerender: «Functions cannot be passed to Client Components»).
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const COMPONENT = 'storefront/app/[lang]/cart/success/GiftCodes.tsx';
const PAGE = 'storefront/app/[lang]/cart/success/page.tsx';
const DICT = 'storefront/lib/dictionaries.ts';

describe('витрина: блок кода сертификата на странице успеха', () => {
  const src = read(COMPONENT);
  const page = read(PAGE);

  it('страница монтирует блок и передаёт ему номер+токен', () => {
    expect(page).toMatch(/import\s+GiftCodes\s+from\s+'\.\/GiftCodes'/);
    expect(page).toMatch(/<GiftCodes[\s\S]{0,200}number=\{number\}/);
    expect(page).toMatch(/<GiftCodes[\s\S]{0,200}token=\{token\}/);
  });

  it('блок клиентский', () => {
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('🔴 никаких серверных импортов в клиентском блоке', () => {
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec.startsWith('node:')).toBe(false);
      expect(spec).not.toMatch(/next\/headers|server-only|postgres|@\/lib\/db/);
    }
    // Ни один импорт не уходит за пределы витрины (в код админки/платформы).
    expect(imports.every((s) => !s.includes('../../../../../lib'))).toBe(true);
  });

  it('🔴 код берётся отдельным эндпоинтом по токену, а не из DTO заказа', () => {
    expect(src).toContain('/gift-codes');
    expect(src).toMatch(/token=\$\{encodeURIComponent\(token\)\}/);
    // Email-путь доступа к заказу для кода недопустим.
    expect(src).not.toMatch(/[?&]email=/);
  });

  it('🔴 ответ с кодом не кешируется', () => {
    expect(src).toMatch(/cache:\s*'no-store'/);
  });

  it('опрос ограничен: 5 c и не более 24 попыток, затем внятный текст', () => {
    expect(src).toMatch(/GIFT_CODES_POLL_INTERVAL_MS\s*=\s*5000/);
    expect(src).toMatch(/GIFT_CODES_POLL_MAX_ATTEMPTS\s*=\s*24/);
    // Есть и остановка (флаг таймаута), и её текст.
    expect(src).toContain('setTimedOut(true)');
    expect(src).toContain('giftTimeout');
    // Антипаттерн: вечный setInterval без счётчика попыток.
    expect(src).not.toContain('setInterval(');
  });

  it('три состояния: none — блок не рендерится вовсе', () => {
    expect(src).toMatch(/state === 'none'\) return null/);
    expect(src).toContain("payload.state === 'ready'");
  });

  it('готовый код показан моноширинно, с копированием, номиналом и сроком', () => {
    expect(src).toMatch(/<code[\s\S]{0,160}?>\s*\{c\.code\}\s*<\/code>/);
    expect(src).toMatch(/fontFamily:[^\n]*monospace/);
    expect(src).toContain('clipboard');
    expect(src).toContain('giftAmount');
    expect(src).toContain('giftValidUntil');
    expect(src).toContain('giftForever');
    expect(src).toContain('giftWarning');
  });
});

describe('🔴 OrderPublicDto не расширяется кодом сертификата (guard по исходнику)', () => {
  const dto = read('lib/storefront/order-dto.ts');
  const orderRoute = read('app/api/storefront/v1/orders/[number]/route.ts');

  /** Тело именованного блока (интерфейса/функции) до закрывающей скобки уровня 0. */
  function block(src: string, header: string): string {
    const at = src.indexOf(header);
    expect(at, `${header} не найден`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`не удалось выделить тело ${header}`);
  }

  it('ни интерфейс, ни маппер не содержат code (кроме промокода)', () => {
    for (const header of ['export interface OrderPublicDto', 'export function toOrderPublicDto']) {
      const body = block(dto, header).replace(/promoCode/g, '');
      expect(body, header).not.toMatch(/code/i);
    }
  });

  it('общий роут заказа не тянет модуль кодов сертификата', () => {
    expect(orderRoute).not.toContain('gift-order-codes');
    expect(orderRoute).not.toContain('gift-certificates');
  });
});

describe('словари витрины', () => {
  const dict = read(DICT);

  it('🔴 ложного обещания про письмо больше нет ни на одном языке', () => {
    expect(dict).not.toContain('отправили детали на вашу почту');
    expect(dict).not.toContain('sent the details to your email');
    expect(dict).not.toContain('envoyé les détails à votre adresse');
  });

  it('строки блока сертификата есть во всех трёх языках', () => {
    for (const key of [
      'giftTitle',
      'giftPending',
      'giftRefresh',
      'giftTimeout',
      'giftAmount',
      'giftRemaining',
      'giftValidUntil',
      'giftForever',
      'giftCopy',
      'giftCopied',
      'giftWarning',
    ]) {
      // 1 объявление в интерфейсе Dictionary + 3 словаря (ru/en/fr).
      const count = dict.split(`${key}:`).length - 1;
      expect(count, `${key} должен быть в интерфейсе и в ru/en/fr`).toBe(4);
    }
  });

  it('🔴 в словаре только строки: функций нет (иначе ломается prerender)', () => {
    for (const key of ['giftPending:', 'giftTimeout:', 'giftWarning:', 'emailNote:']) {
      let from = 0;
      for (;;) {
        const at = dict.indexOf(key, from);
        if (at < 0) break;
        const chunk = dict.slice(at, at + 400);
        expect(chunk).not.toMatch(/^[^\n]*=>/m);
        from = at + key.length;
      }
    }
  });
});
