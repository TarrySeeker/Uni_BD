import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD полноты каталогов интерфейса админки (next-intl foundation, STEP I).
 *
 * Это страховочная сеть на всю волну i18n: пока компоненты по одному переключаются
 * на t('...'), каталоги ru/en/fr обязаны оставаться СИНХРОННЫМИ по ключам и
 * согласованными по ICU-плейсхолдерам. Пропущенный ключ в en/fr = «дыра» в
 * интерфейсе (next-intl отрендерит сырой ключ или упадёт); лишний плейсхолдер в
 * переводе = рантайм-ошибка форматирования. Тест ловит обе беды статически.
 *
 * Проверяет:
 *   1) все три messages/{ru,en,fr}.json — валидный JSON;
 *   2) их ПЛОСКИЕ наборы ключей ИДЕНТИЧНЫ (падает с диффом недостающих/лишних);
 *   3) каждый ICU-плейсхолдер ({name}, {count}, …) из ru-значения присутствует в
 *      en- и fr-значении того же ключа.
 */

const MESSAGES_DIR = join(__dirname, '../../messages');
const LOCALES = ['ru', 'en', 'fr'] as const;

/** Читает и парсит каталог; ошибка парсинга = падение с внятным сообщением. */
function loadCatalog(locale: string): Record<string, unknown> {
  const path = join(MESSAGES_DIR, `${locale}.json`);
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`messages/${locale}.json — невалидный JSON: ${(e as Error).message}`);
  }
}

/** Разворачивает вложенный объект в плоскую карту 'a.b.c' → строковое значение. */
function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === 'string') {
    out[prefix] = obj;
  } else {
    // Каталоги интерфейса — только строки-листья; иное = ошибка структуры.
    throw new Error(`Ключ «${prefix}» не строка (${typeof obj}) — ожидались только строковые значения`);
  }
  return out;
}

/**
 * Извлекает имена ICU-аргументов из строки: '{name}' → 'name',
 * '{count, plural, ...}' → 'count'. Возвращает множество имён.
 */
function icuTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of value.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)) {
    tokens.add(m[1]);
  }
  return tokens;
}

const catalogs = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(loadCatalog(l))]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

describe('i18n admin messages: каталоги валидны и синхронны', () => {
  it('все три каталога распарсились как валидный JSON', () => {
    for (const l of LOCALES) {
      expect(Object.keys(catalogs[l]).length).toBeGreaterThan(0);
    }
  });

  it('плоские наборы ключей ru/en/fr идентичны', () => {
    const ruKeys = new Set(Object.keys(catalogs.ru));

    for (const l of ['en', 'fr'] as const) {
      const keys = new Set(Object.keys(catalogs[l]));
      const missing = [...ruKeys].filter((k) => !keys.has(k)); // есть в ru, нет в l
      const extra = [...keys].filter((k) => !ruKeys.has(k)); // есть в l, нет в ru

      expect(
        { locale: l, missing, extra },
        `Каталог «${l}» рассинхронизирован с ru:\n` +
          (missing.length ? `  ОТСУТСТВУЮТ: ${missing.join(', ')}\n` : '') +
          (extra.length ? `  ЛИШНИЕ: ${extra.join(', ')}\n` : ''),
      ).toEqual({ locale: l, missing: [], extra: [] });
    }
  });

  it('ICU-плейсхолдеры ru-значений присутствуют в en и fr', () => {
    const problems: string[] = [];

    for (const [key, ruValue] of Object.entries(catalogs.ru)) {
      const ruTokens = icuTokens(ruValue);
      if (ruTokens.size === 0) continue;

      for (const l of ['en', 'fr'] as const) {
        const translated = catalogs[l][key];
        if (translated === undefined) continue; // словлено проверкой ключей выше
        const theirTokens = icuTokens(translated);
        const lost = [...ruTokens].filter((t) => !theirTokens.has(t));
        if (lost.length) {
          problems.push(`${key} [${l}]: потеряны плейсхолдеры {${lost.join('}, {')}}`);
        }
      }
    }

    expect(problems, `Рассогласование ICU-плейсхолдеров:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});
