import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD локализации КОРНЕВЫХ метаданных и корневой страницы админки.
 *
 * WHY: при NEXT_LOCALE=en/fr страница логина переводилась, а <title> оставался
 * русским во всех трёх локалях — заголовок был статическим литералом в
 * `export const metadata` (app/layout.tsx), а `<h1>` корневой страницы —
 * русским хардкодом. Статический `metadata` вычисляется вне запроса, поэтому
 * локаль оператора (cookie NEXT_LOCALE) до него не доходит физически: лечится
 * только переходом на `generateMetadata()` с серверным `getTranslations()`.
 *
 * Тестов React-компонентов в проекте нет (vitest environment 'node'), поэтому
 * сторожим ИСХОДНИКИ чтением (образец — tests/designers/list-ui-guard.test.ts) и
 * сверяем ключи с эталоном messages/ru.json.
 *
 * Последний describe сторожит ПРИЧИНУ, а не два известных файла: любой статический
 * `export const metadata` с русским литералом где угодно под app/ — тот же дефект.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const layoutSrc = () => read('app/layout.tsx');
const pageSrc = () => read('app/page.tsx');

/** Ключи заголовка/описания платформы — единственный источник корневых метаданных. */
const TITLE_KEY = 'common.app.title';
const DESCRIPTION_KEY = 'common.app.description';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

/**
 * Убирает комментарии (`//…` и `/*…*\/`): в проекте комментарии по-русски —
 * это стиль, а не дефект. Ищем кириллицу только в КОДЕ.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Значение ключа из каталога сообщений по плоскому пути 'a.b.c'. */
function message(locale: string, key: string): unknown {
  const catalog = JSON.parse(read(`messages/${locale}.json`)) as Record<string, unknown>;
  return key.split('.').reduce<unknown>(
    (acc, part) =>
      acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined,
    catalog,
  );
}

describe('корневые метаданные: заголовок берётся из каталога переводов', () => {
  it('app/layout.tsx отдаёт метаданные через generateMetadata(), а не статическим объектом', () => {
    const src = layoutSrc();
    expect(src).toMatch(/export\s+async\s+function\s+generateMetadata\s*\(/);
    // Антипаттерн: статический metadata вычисляется вне запроса — локаль до него не
    // доходит. Комментарии не считаем: там эта конструкция упоминается как «нельзя».
    expect(stripComments(src)).not.toMatch(/export\s+const\s+metadata\b/);
  });

  it('app/layout.tsx локализует заголовок и описание серверным getTranslations()', () => {
    const src = layoutSrc();
    expect(src).toContain("from 'next-intl/server'");
    expect(src).toContain('getTranslations');
    expect(src).toContain(`'${TITLE_KEY}'`);
    expect(src).toContain(`'${DESCRIPTION_KEY}'`);
  });

  it('атрибут lang <html> следует локали оператора, а не забит как ru', () => {
    const src = layoutSrc();
    expect(src).not.toMatch(/lang="ru"/);
    expect(src).toContain('getLocale');
    expect(src).toMatch(/lang=\{/);
  });

  it('app/page.tsx рендерит заголовок через переводчик', () => {
    const src = pageSrc();
    expect(src).toContain('getTranslations');
    expect(src).toContain(`'${TITLE_KEY}'`);
  });

  it('в коде app/layout.tsx и app/page.tsx нет русских литералов', () => {
    for (const file of ['app/layout.tsx', 'app/page.tsx']) {
      const code = stripComments(read(file));
      expect(CYRILLIC_RE.test(code), `${file}: русский литерал в коде — вынесите в messages/*`).toBe(
        false,
      );
    }
  });
});

describe('корневые метаданные: ключи существуют во всех трёх каталогах', () => {
  for (const key of [TITLE_KEY, DESCRIPTION_KEY]) {
    it(`«${key}» переведён в ru/en/fr непустой строкой`, () => {
      for (const locale of ['ru', 'en', 'fr']) {
        const value = message(locale, key);
        expect(typeof value, `${locale}: ${key} отсутствует`).toBe('string');
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    });
  }

  it('ru-заголовок — это тот самый заголовок панели (эталон для <title>)', () => {
    expect(message('ru', TITLE_KEY)).toContain('панель управления');
  });

  it('en/fr-переводы заголовка НЕ русские (иначе это заглушка-копипаста)', () => {
    for (const locale of ['en', 'fr']) {
      expect(CYRILLIC_RE.test(message(locale, TITLE_KEY) as string)).toBe(false);
      expect(CYRILLIC_RE.test(message(locale, DESCRIPTION_KEY) as string)).toBe(false);
    }
  });
});

describe('класс дефекта: ни один статический metadata под app/ не содержит русских литералов', () => {
  const SKIP_DIRS = new Set(['node_modules', '.next']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it('статических metadata с кириллицей нет', () => {
    const offenders: string[] = [];

    for (const file of walk(join(ROOT, 'app'))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // Тело объекта статических метаданных: от `export const metadata` до закрывающей `};`.
      const m = /export\s+const\s+metadata\b[\s\S]*?\n\}/.exec(src);
      if (m && CYRILLIC_RE.test(m[0])) offenders.push(relative(ROOT, file));
    }

    expect(
      offenders,
      'Русский литерал в статических метаданных — <title> не переведётся ни при какой ' +
        `локали. Переведите на generateMetadata() + getTranslations():\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
