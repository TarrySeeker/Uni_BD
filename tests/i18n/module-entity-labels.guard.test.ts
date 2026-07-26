import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { ALL_MODULES } from '@/lib/config/modules';
import { MODULE_LABEL_KEYS, CORE_LABEL_KEY, moduleLabel } from '@/lib/config/module-labels';

/**
 * GUARD: подписи МОДУЛЕЙ платформы и подписи СУЩНОСТЕЙ матрицы покрытия переводов
 * приходят из каталогов сообщений, а не из русских литералов в исходниках
 * (очаги 1 и 2 живой браузерной проверки: /admin/settings и
 * /admin/settings/languages показывали «Каталог», «Заказы», «Категории» при en/fr).
 *
 * Тестов React-компонентов в проекте нет (vitest environment 'node'), поэтому
 * вёрстку сторожим чтением исходников (эталоны: tests/designers/list-ui-guard.test.ts,
 * tests/settings/languages-form.guard.test.ts).
 *
 * Стережём три инварианта:
 *   1) КАЖДЫЙ модуль ALL_MODULES (+ псевдомодуль core групп прав) имеет ключ
 *      подписи, который резолвится в messages/ru.json;
 *   2) сущности матрицы покрытия перечислены в coverage-data.ts КЛЮЧАМИ, и все
 *      они есть в ru.json;
 *   3) АНТИПАТТЕРН: в исходниках этих экранов нет русских литералов подписей
 *      (единственный источник правды — messages/*), и перечисление модулей не
 *      продублировано вторым набором ключей в каталогах.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const LOCALES = ['ru', 'en', 'fr'] as const;
const catalogs = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

/** Значение ключа 'a.b.c' из каталога; undefined, если ключа нет или он не строка. */
function value(locale: (typeof LOCALES)[number], dotted: string): string | undefined {
  let node: unknown = catalogs[locale];
  for (const part of dotted.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

/** Узел каталога (для проверки отсутствия целой группы ключей). */
function node(locale: (typeof LOCALES)[number], dotted: string): unknown {
  let cur: unknown = catalogs[locale];
  for (const part of dotted.split('.')) {
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
  }
  return cur;
}

/** Убирает комментарии — они на русском по правилам проекта и проверке не подлежат. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

const CYRILLIC = /[А-Яа-яЁё]/;

// =============================================================================
// 1) Подписи модулей
// =============================================================================
describe('подписи модулей платформы — из каталога сообщений', () => {
  it('каждый модуль ALL_MODULES имеет ключ подписи', () => {
    const missing = ALL_MODULES.filter((name) => !MODULE_LABEL_KEYS[name]);
    expect(missing, `модули без ключа подписи: ${missing.join(', ')}`).toEqual([]);
  });

  it('все ключи подписей модулей резолвятся в ru/en/fr непустой строкой', () => {
    const keys = [...Object.values(MODULE_LABEL_KEYS), CORE_LABEL_KEY];
    const problems: string[] = [];
    for (const key of keys) {
      for (const l of LOCALES) {
        const v = value(l, key);
        if (!v || v.trim().length === 0) problems.push(`${key} [${l}]`);
      }
    }
    expect(problems, `не резолвятся: ${problems.join(', ')}`).toEqual([]);
  });

  it('moduleLabel резолвит модуль и core через t, неизвестный код — passthrough', () => {
    const t = (key: string) => `T:${key}`;
    expect(moduleLabel('catalog', t)).toBe(`T:${MODULE_LABEL_KEYS.catalog}`);
    expect(moduleLabel('core', t)).toBe(`T:${CORE_LABEL_KEY}`);
    expect(moduleLabel('unknown_module', t)).toBe('unknown_module');
  });

  it('en/fr подписи модулей — НЕ копия русских (реально переведены)', () => {
    const keys = [...Object.values(MODULE_LABEL_KEYS), CORE_LABEL_KEY];
    const untranslated = keys.filter((k) => CYRILLIC.test(value('en', k) ?? '') || CYRILLIC.test(value('fr', k) ?? ''));
    expect(untranslated, `остались по-русски: ${untranslated.join(', ')}`).toEqual([]);
  });

  it('перечисление модулей НЕ продублировано вторым набором ключей (roles.roleForm.modules)', () => {
    for (const l of LOCALES) {
      expect(node(l, 'roles.roleForm.modules'), `messages/${l}.json`).toBeUndefined();
    }
    expect(read('app/admin/(panel)/roles/_components/RoleForm.tsx')).toContain('moduleLabel');
    expect(read('app/admin/(panel)/roles/_components/RoleForm.tsx')).not.toContain('KNOWN_MODULES');
  });
});

// =============================================================================
// 2) Подписи сущностей матрицы покрытия переводов
// =============================================================================
describe('матрица покрытия переводов — подписи сущностей из каталога', () => {
  const coverageSrc = read('app/admin/(panel)/settings/languages/coverage-data.ts');

  it('coverage-data.ts перечисляет сущности КЛЮЧАМИ, и они есть в ru/en/fr', () => {
    const keys = [...coverageSrc.matchAll(/labelKey:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(keys.length, 'в coverage-data.ts не найдено ни одного labelKey').toBeGreaterThanOrEqual(5);
    const problems: string[] = [];
    for (const key of keys) {
      for (const l of LOCALES) {
        if (!value(l, key)) problems.push(`${key} [${l}]`);
      }
    }
    expect(problems, `не резолвятся: ${problems.join(', ')}`).toEqual([]);
  });

  it('en/fr подписи сущностей реально переведены (нет кириллицы)', () => {
    const keys = [...coverageSrc.matchAll(/labelKey:\s*'([^']+)'/g)].map((m) => m[1]);
    const untranslated = keys.filter((k) => CYRILLIC.test(value('en', k) ?? '') || CYRILLIC.test(value('fr', k) ?? ''));
    expect(untranslated, `остались по-русски: ${untranslated.join(', ')}`).toEqual([]);
  });

  it('страница «Языки» рендерит подпись строки через t(...), а не готовую строку', () => {
    const page = read('app/admin/(panel)/settings/languages/page.tsx');
    expect(page).toMatch(/t\(row\.labelKey\)/);
  });
});

// =============================================================================
// 3) АНТИПАТТЕРН: русские литералы подписей в исходниках
// =============================================================================
describe('АНТИПАТТЕРН: русские подписи модулей/сущностей в исходниках', () => {
  const FILES = [
    'lib/config/module-labels.ts',
    'app/admin/(panel)/settings/_components/modules-form-state.ts',
    'app/admin/(panel)/settings/_components/ModulesForm.tsx',
    'app/admin/(panel)/settings/languages/coverage-data.ts',
    'app/admin/(panel)/settings/languages/page.tsx',
    'app/admin/(panel)/settings/_components/languages-coverage.ts',
    'app/admin/(panel)/roles/_components/RoleForm.tsx',
  ];

  for (const file of FILES) {
    it(`${file} — вне комментариев нет кириллицы`, () => {
      const code = stripComments(read(file));
      const hits = code
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => CYRILLIC.test(line));
      expect(hits, `русские литералы:\n${hits.map((h) => `  ${h.n}: ${h.line}`).join('\n')}`).toEqual([]);
    });
  }
});
