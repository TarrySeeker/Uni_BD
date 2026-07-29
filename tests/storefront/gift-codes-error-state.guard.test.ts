import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Находка №12 — ошибка эндпоинта кодов молча ПРЯЧЕТ блок.
 *
 * Было: fetchGiftCodes глушил и !res.ok, и исключение в null; setPayload
 * вызывался только на непустых данных; ранний выход `if (!payload …) return null`
 * стоял ДО обеих веток рендера. При первом же 429 (лимит 40/мин на IP) покупатель
 * не видел ни кода, ни объяснения, ни таймаута — блок исчезал совсем.
 *
 * Стало: результат запроса — размеченное объединение (ok | rate_limited | error),
 * блок остаётся на экране и объясняет, что происходит; 429 не расходует попытки
 * молча, а переводит в состояние «слишком много запросов, попробуйте позже».
 *
 * GUARD по исходнику: storefront/ исключён из tsconfig корня и React-тестов в
 * проекте нет (environment 'node') — сторожим СУТЬ, а не подстроки.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const COMPONENT = 'storefront/app/[lang]/cart/success/GiftCodes.tsx';
const DICT = 'storefront/lib/dictionaries.ts';

describe('витрина: сбой запроса кодов не прячет блок', () => {
  const src = read(COMPONENT);

  it('🔴 ошибка запроса больше не сваливается в один немой null', () => {
    // Антипаттерн: `if (!res.ok) return null;` и `catch { return null; }`.
    expect(src).not.toMatch(/if\s*\(!res\.ok\)\s*return null/);
    expect(src).not.toMatch(/catch\s*\{\s*return null;\s*\}/);
  });

  it('результат запроса — размеченное объединение с отдельным 429', () => {
    expect(src).toMatch(/res\.status\s*===\s*429/);
    expect(src).toContain("'rate_limited'");
    expect(src).toContain("'error'");
    expect(src).toContain("'ok'");
  });

  it('🔴 ранний выход не выкидывает блок при наличии ошибки', () => {
    // «Ничего не показываем» допустимо ТОЛЬКО когда нет ошибки И состояние none.
    expect(src).toMatch(/if\s*\(!failure\s*&&\s*\(!payload\s*\|\|\s*payload\.state === 'none'\)\)\s*return null/);
  });

  it('покупатель видит объяснение и кнопку повтора при сбое', () => {
    expect(src).toContain('giftRateLimited');
    expect(src).toContain('giftError');
    expect(src).toContain('giftRefresh');
  });

  /**
   * 🔴 storefront/ ИСКЛЮЧЁН из tsconfig корня — tsc здесь не ловит ничего.
   * После ослабления раннего выхода payload может быть null на пути «сбой до
   * первого успешного ответа», и обращение к payload.state уронило бы страницу
   * успеха целиком. Проверяем разыменования по исходнику.
   */
  it('🔴 payload разыменовывается только после явной проверки на null', () => {
    // Первое обращение к payload в РЕНДЕРЕ (после раннего выхода) обязано нести
    // проверку `payload &&` в том же условии: с ослабленным ранним выходом
    // payload может быть null на пути «сбой до первого успешного ответа».
    const renderStart = src.indexOf('if (!failure && (!payload');
    expect(renderStart, 'ранний выход не найден').toBeGreaterThan(-1);
    const afterGuard = src.slice(src.indexOf('\n', renderStart));
    const firstUse = afterGuard.search(/(?<![.\w])payload[.[]/);
    expect(firstUse, 'payload в рендере не используется вовсе').toBeGreaterThan(-1);
    // Строка первого обращения содержит и проверку, и само обращение.
    const lineStart = afterGuard.lastIndexOf('\n', firstUse) + 1;
    const line = afterGuard.slice(lineStart, afterGuard.indexOf('\n', firstUse));
    expect(line, `небезопасное разыменование: ${line.trim()}`).toMatch(/payload &&/);
  });

  it('429 останавливает опрос, а не молотит лимит дальше', () => {
    // При rate_limited цикл прекращается (иначе ведро не разгрузится никогда).
    expect(src).toMatch(/rate_limited[\s\S]{0,400}return;/);
  });

  it('после успешного повтора ошибка гаснет (не залипает навсегда)', () => {
    expect(src).toMatch(/setFailure\(null\)/);
  });

  it('опрос по-прежнему ограничен и завершается таймаутом', () => {
    expect(src).toMatch(/GIFT_CODES_POLL_INTERVAL_MS\s*=\s*5000/);
    expect(src).toMatch(/GIFT_CODES_POLL_MAX_ATTEMPTS\s*=\s*24/);
    expect(src).toContain('setTimedOut(true)');
    expect(src).not.toContain('setInterval(');
  });

  it('🔴 блок остаётся клиентским и без серверных импортов', () => {
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec.startsWith('node:')).toBe(false);
      expect(spec).not.toMatch(/next\/headers|server-only|postgres|@\/lib\/db/);
    }
  });
});

describe('витрина: словари новых состояний во всех трёх языках', () => {
  const dict = read(DICT);

  it('giftRateLimited и giftError объявлены и переведены (ru/en/fr + интерфейс)', () => {
    for (const key of ['giftRateLimited', 'giftError']) {
      const count = dict.split(`${key}:`).length - 1;
      expect(count, `${key} должен быть в интерфейсе и в ru/en/fr`).toBe(4);
    }
  });

  it('🔴 en/fr — осмысленный перевод, а не копия русского', () => {
    const values = (key: string): string[] =>
      [...dict.matchAll(new RegExp(`${key}:\\s*\n?\\s*'([^']*)'`, 'g'))].map((m) => m[1]!);
    for (const key of ['giftRateLimited', 'giftError']) {
      const vals = values(key).filter((v) => v.length > 0);
      expect(vals.length, `${key}: значения не найдены`).toBeGreaterThanOrEqual(3);
      // Кириллица ровно в одном (русском) значении из трёх словарей.
      const cyrillic = vals.filter((v) => /[а-яА-ЯёЁ]/.test(v));
      expect(cyrillic.length, `${key}: русский текст просочился в en/fr`).toBe(1);
      // Все три различны — копипаста исключена.
      expect(new Set(vals).size).toBe(vals.length);
    }
  });

  it('🔴 в словаре только строки: функций нет (иначе ломается prerender)', () => {
    for (const key of ['giftRateLimited:', 'giftError:']) {
      let from = 0;
      for (;;) {
        const at = dict.indexOf(key, from);
        if (at < 0) break;
        expect(dict.slice(at, at + 400)).not.toMatch(/^[^\n]*=>/m);
        from = at + key.length;
      }
    }
  });
});
