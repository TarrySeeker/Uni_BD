/**
 * GUARD (волна 6-Б, ОЧАГ 3): редактор CMS-секций не должен содержать русских
 * подписей В КОДЕ — ни подписей типов секций, ни label/hint полей формы.
 *
 * Почему guard по исходнику, а не тест компонента: тестов React-компонентов в
 * проекте нет (vitest environment 'node'), поэтому вёрстку сторожим чтением
 * файлов (образцы — tests/designers/list-ui-guard.test.ts,
 * tests/cms/section-translations-guard.test.ts).
 *
 * Инварианты:
 *   1. lib/cms/section-form.ts (вне комментариев) не содержит кириллицы —
 *      SECTION_TYPE_LABEL_KEYS и SECTION_FIELD_SPECS хранят i18n-КЛЮЧИ;
 *   2. блок SECTION_TR_FIELD_SPECS в lib/cms/section-i18n.ts — тоже только ключи
 *      (он рендерится тем же FieldControl, значит обязан жить в той же схеме;
 *      русские тексты серверных ошибок этого модуля — отдельный очаг, их не трогаем);
 *   3. каждый ключ подписи/подсказки/варианта select резолвится в ru, en И fr;
 *   4. рендер-сайты (SectionForm.tsx, SectionEditor.tsx) резолвят ключ через t(),
 *      а не печатают его сырым.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { SECTION_FIELD_SPECS, SECTION_TYPE_LABEL_KEYS } from '@/lib/cms/section-form';
import { SECTION_TR_FIELD_SPECS } from '@/lib/cms/section-i18n';
import { CMS_SECTION_TYPES } from '@/lib/cms/types';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const LOCALES = ['ru', 'en', 'fr'] as const;
const CATALOGS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

const CYRILLIC = /[Ѐ-ӿ]/;

/** Вырезает комментарии (документация проекта — на русском, это норма). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Резолвит точечный ключ в каталоге сообщений; undefined — ключа нет. */
function lookup(catalog: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Все i18n-ключи, которые редактор секций отдаёт в t(). */
function allSpecKeys(): string[] {
  const keys: string[] = Object.values(SECTION_TYPE_LABEL_KEYS);
  for (const type of CMS_SECTION_TYPES) {
    for (const specs of [SECTION_FIELD_SPECS[type], SECTION_TR_FIELD_SPECS[type]]) {
      for (const field of specs) {
        keys.push(field.labelKey);
        if (field.hintKey) keys.push(field.hintKey);
        for (const opt of field.options ?? []) keys.push(opt.labelKey);
      }
    }
  }
  return keys;
}

describe('ОЧАГ 3: в дескрипторах секций лежат ключи, а не русский текст', () => {
  it('lib/cms/section-form.ts вне комментариев не содержит кириллицы', () => {
    const code = stripComments(read('lib/cms/section-form.ts'));
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => CYRILLIC.test(line));
    expect(offenders, `русские литералы в коде: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('блок SECTION_TR_FIELD_SPECS в section-i18n.ts не содержит кириллицы', () => {
    const src = read('lib/cms/section-i18n.ts');
    const block = /export const SECTION_TR_FIELD_SPECS[\s\S]*?\n};/.exec(src)?.[0];
    expect(block, 'не найден блок SECTION_TR_FIELD_SPECS').toBeTruthy();
    expect(CYRILLIC.test(stripComments(block!))).toBe(false);
  });

  it('каждый тип секции имеет ключ подписи в пространстве cms.sectionTypes.*', () => {
    for (const type of CMS_SECTION_TYPES) {
      const key = SECTION_TYPE_LABEL_KEYS[type];
      expect(typeof key, `тип ${type}`).toBe('string');
      expect(key, `тип ${type}`).toMatch(/^cms\.sectionTypes\./);
    }
    expect(Object.keys(SECTION_TYPE_LABEL_KEYS).sort()).toEqual([...CMS_SECTION_TYPES].sort());
  });

  it('label/hint/options всех полей — ключи cms.sectionFields.*, без кириллицы', () => {
    for (const type of CMS_SECTION_TYPES) {
      for (const specs of [SECTION_FIELD_SPECS[type], SECTION_TR_FIELD_SPECS[type]]) {
        for (const field of specs) {
          const where = `${type}.${field.name}`;
          expect(field.labelKey, where).toMatch(/^cms\.sectionFields\./);
          expect(CYRILLIC.test(field.labelKey), where).toBe(false);
          if (field.hintKey !== undefined) {
            expect(field.hintKey, where).toMatch(/^cms\.sectionFields\./);
            expect(CYRILLIC.test(field.hintKey), where).toBe(false);
          }
          for (const opt of field.options ?? []) {
            expect(opt.labelKey, `${where}.${opt.value}`).toMatch(/^cms\.sectionFields\./);
            expect(CYRILLIC.test(opt.labelKey), `${where}.${opt.value}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('ОЧАГ 3: ключи редактора секций резолвятся во всех локалях', () => {
  const keys = allSpecKeys();

  it('набор ключей непустой и покрывает типы + поля', () => {
    // 7 типов + минимум по одному полю на тип.
    expect(keys.length).toBeGreaterThan(CMS_SECTION_TYPES.length);
  });

  for (const locale of LOCALES) {
    it(`все ключи присутствуют в messages/${locale}.json и непусты`, () => {
      const missing = keys.filter((k) => {
        const v = lookup(CATALOGS[locale], k);
        return v === undefined || v.trim().length === 0;
      });
      expect(missing, `нет перевода (${locale}): ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('ru-подписи типов секций остались теми же человекочитаемыми фразами', () => {
    expect(lookup(CATALOGS.ru, SECTION_TYPE_LABEL_KEYS.text)).toBe('Текстовый блок');
    expect(lookup(CATALOGS.ru, SECTION_TYPE_LABEL_KEYS.products_grid)).toBe('Сетка товаров');
  });

  it('en/fr переводы отличаются от ru (перевод сделан, а не скопирован)', () => {
    for (const type of CMS_SECTION_TYPES) {
      const key = SECTION_TYPE_LABEL_KEYS[type];
      const ru = lookup(CATALOGS.ru, key)!;
      for (const locale of ['en', 'fr'] as const) {
        expect(lookup(CATALOGS[locale], key), `${key} @ ${locale}`).not.toBe(ru);
      }
    }
  });
});

describe('ОЧАГ 3: рендер-сайты резолвят ключи через t()', () => {
  const formSrc = read('app/admin/(panel)/cms/_components/SectionForm.tsx');
  const editorSrc = read('app/admin/(panel)/cms/_components/SectionEditor.tsx');

  it('SectionForm рендерит подпись/подсказку/вариант через переводчик', () => {
    expect(formSrc).toMatch(/t\(\s*field\.labelKey\s*\)/);
    expect(formSrc).toMatch(/t\(\s*field\.hintKey\s*\)/);
    expect(formSrc).toMatch(/t\(\s*o(pt)?\.labelKey\s*\)/);
  });

  it('SectionForm не печатает сырые поля дескриптора', () => {
    expect(formSrc).not.toMatch(/\{\s*field\.label\s*\}/);
    expect(formSrc).not.toMatch(/\{\s*field\.hint\s*\}/);
    expect(formSrc).not.toMatch(/=\{\s*field\.hint\s*\}/);
    expect(formSrc).not.toMatch(/=\{\s*field\.label\s*\}/);
    expect(formSrc).not.toMatch(/\{\s*o\.label\s*\}/);
  });

  it('SectionEditor резолвит подпись типа секции хелпером, а не печатает ключ', () => {
    expect(editorSrc).toContain('sectionTypeLabel');
    expect(editorSrc).not.toMatch(/\{\s*SECTION_TYPE_LABEL_KEYS\[/);
  });
});
