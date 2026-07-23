import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  resolveLocaleTabsState,
} from '../../app/admin/(panel)/_components/locale-tabs-state';

/**
 * T2 — вкладки языков на экранах СОЗДАНИЯ.
 *
 * Юниты: чистая логика «показать вкладки / показать объяснение вместо них».
 * Guard-тесты по исходникам: проп locales обязателен и передан на всех страницах,
 * молчаливого схлопывания панели переводов в исходнике нет.
 */

const ROOT = path.resolve(__dirname, '../..');
const PANEL = path.join(ROOT, 'app/admin/(panel)');
const LOCALE_TABS = path.join(PANEL, '_components/LocaleTabs.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Рекурсивный обход .tsx-файлов панели админки. */
function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkTsx(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const PANEL_FILES = walkTsx(PANEL);

/** Файлы, где реально смонтирован <LocaleTabs> (формы админки). */
const FORM_FILES = PANEL_FILES.filter((f) => read(f).includes('<LocaleTabs'));

describe('resolveLocaleTabsState — когда показывать вкладки перевода', () => {
  const many = { locales: ['ru', 'en', 'fr'] as const, defaultLocale: 'ru' };

  it('редактирование при нескольких языках → вкладки, дефолтный язык первым', () => {
    const s = resolveLocaleTabsState({ ...many, mode: 'edit' });
    expect(s.kind).toBe('tabs');
    if (s.kind !== 'tabs') return;
    expect(s.tabs).toEqual(['ru', 'en', 'fr']);
  });

  it('дефолтный язык не обязан быть первым в наборе — вкладка «основной» всё равно первая', () => {
    const s = resolveLocaleTabsState({
      locales: ['en', 'fr', 'ru'],
      defaultLocale: 'ru',
      mode: 'edit',
    });
    expect(s.kind === 'tabs' && s.tabs).toEqual(['ru', 'en', 'fr']);
  });

  it('один язык в магазине → не вкладки, а объяснение (reason=single-locale)', () => {
    const s = resolveLocaleTabsState({ locales: ['ru'], defaultLocale: 'ru', mode: 'edit' });
    expect(s.kind).toBe('notice');
    if (s.kind !== 'notice') return;
    expect(s.reason).toBe('single-locale');
    expect(s.text.length).toBeGreaterThan(0);
  });

  it('создание без поддержки переводов в create-действии → объяснение, а не тишина', () => {
    const s = resolveLocaleTabsState({ ...many, mode: 'create' });
    expect(s.kind).toBe('notice');
    if (s.kind !== 'notice') return;
    expect(s.reason).toBe('create-first');
    // Пользователь должен увидеть, КАКИЕ языки его ждут и ЧТО сделать.
    expect(s.text).toContain('EN');
    expect(s.text).toContain('FR');
    expect(s.text).toContain('RU');
  });

  it('создание, когда create-действие принимает переводы → вкладки сразу', () => {
    const s = resolveLocaleTabsState({
      ...many,
      mode: 'create',
      supportsCreateTranslations: true,
    });
    expect(s.kind === 'tabs' && s.tabs).toEqual(['ru', 'en', 'fr']);
  });

  it('один язык побеждает режим создания (переводить нечего)', () => {
    const s = resolveLocaleTabsState({
      locales: ['ru'],
      defaultLocale: 'ru',
      mode: 'create',
      supportsCreateTranslations: true,
    });
    expect(s.kind === 'notice' && s.reason).toBe('single-locale');
  });

  it('мультитенантность: дефолт не «ru» — тексты строятся из конфига, без хардкода', () => {
    const s = resolveLocaleTabsState({
      locales: ['en', 'de'],
      defaultLocale: 'en',
      mode: 'create',
    });
    expect(s.kind).toBe('notice');
    if (s.kind !== 'notice') return;
    expect(s.text).toContain('DE');
    expect(s.text).toContain('EN');
    expect(s.text).not.toContain('RU');
  });

  it('дубли языков в конфиге не дают дублей вкладок', () => {
    const s = resolveLocaleTabsState({
      locales: ['ru', 'en', 'en'],
      defaultLocale: 'ru',
      mode: 'edit',
    });
    expect(s.kind === 'tabs' && s.tabs).toEqual(['ru', 'en']);
  });
});

describe('guard: LocaleTabs не схлопывается молча', () => {
  const src = read(LOCALE_TABS);

  it('механизм есть: панель решает через resolveLocaleTabsState и рендерит объяснение', () => {
    expect(src).toContain('resolveLocaleTabsState');
    // Текст объяснения из чистой логики реально попадает в разметку.
    expect(src).toMatch(/state\.text/);
  });

  it('антипаттерн запрещён: нет булева пропа enabled и нет тихого возврата children', () => {
    expect(src).not.toMatch(/\benabled\b/);
    expect(src).not.toMatch(/return\s*<>\{children\}<\/>/);
  });
});

describe('guard: locales приходит на все формы с LocaleTabs', () => {
  it('формы с LocaleTabs найдены', () => {
    expect(FORM_FILES.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of FORM_FILES) {
    const rel = path.relative(ROOT, file);
    const src = read(file);

    it(`${rel}: пропы locales/defaultLocale обязательные, без дефолта-маски`, () => {
      // Дефолт ['ru'] маскировал забытый проп — запрещён.
      expect(src).not.toMatch(/locales\s*=\s*\[/);
      expect(src).not.toMatch(/defaultLocale\s*=\s*'/);
      // Обязательность в типе пропсов (нет `locales?:`).
      expect(src).not.toMatch(/locales\?:/);
      expect(src).not.toMatch(/defaultLocale\?:/);
      expect(src).toMatch(/locales:\s*readonly string\[\]/);
      expect(src).toMatch(/defaultLocale:\s*string/);
    });

    it(`${rel}: не использует снятый проп enabled`, () => {
      expect(src).not.toMatch(/enabled=\{/);
    });
  }
});

describe('guard: страницы админки передают языки в формы', () => {
  const formNames = FORM_FILES.map((f) => path.basename(f, '.tsx'));

  const pages = PANEL_FILES.filter((f) => path.basename(f) === 'page.tsx');
  /** Текст самого JSX-тега монтирования формы (от `<Name` до конца тега). */
  function mountTag(src: string, name: string): string {
    const start = src.indexOf(`<${name}`);
    const end = src.indexOf('>', start);
    return src.slice(start, end + 1);
  }

  const mounts = pages.flatMap((file) => {
    const src = read(file);
    return formNames
      .filter((name) => src.includes(`<${name}`))
      .map((name) => ({ file, name, src, tag: mountTag(src, name) }));
  });

  it('страницы, монтирующие формы, найдены (включая экраны создания)', () => {
    expect(mounts.length).toBeGreaterThanOrEqual(10);
    expect(mounts.some((m) => m.file.includes('/new/'))).toBe(true);
  });

  for (const m of mounts) {
    const rel = path.relative(ROOT, m.file);
    it(`${rel}: <${m.name}> получает locales и defaultLocale`, () => {
      expect(m.tag).toMatch(/locales=\{/);
      expect(m.tag).toMatch(/defaultLocale=\{/);
      // Языки берутся из конфигурации магазина, а не из литерала в странице.
      expect(m.src).toContain('getLocaleConfig');
    });
  }
});
