/**
 * T5 — guard-тесты по исходникам: перевод тела CMS-страницы должен доезжать
 * ИЗ ФОРМЫ В КОЛОНКУ, а не останавливаться на полпути.
 *
 * Сторожим СУТЬ, а не подстроку: для каждого звена цепочки (форма секции →
 * редактор → Server Action → SQL) проверяется, что механизм есть, И что
 * антипаттерн «поле в форме есть, а в запись не доезжает» невозможен.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SECTION_FORM = path.join(ROOT, 'app/admin/(panel)/cms/_components/SectionForm.tsx');
const SECTION_EDITOR = path.join(ROOT, 'app/admin/(panel)/cms/_components/SectionEditor.tsx');
const PAGE_FORM = path.join(ROOT, 'app/admin/(panel)/cms/_components/PageForm.tsx');
const ACTIONS = path.join(ROOT, 'lib/cms/actions.ts');
const SCHEMAS = path.join(ROOT, 'lib/cms/schemas.ts');

const read = (p: string) => readFileSync(p, 'utf8');

describe('guard: форма секции умеет переводы', () => {
  const src = read(SECTION_FORM);

  it('механизм есть: вкладки языков и поля перевода из whitelist секции', () => {
    expect(src).toContain('sectionLocaleTabs');
    expect(src).toContain('SECTION_TR_FIELD_SPECS');
    expect(src).toMatch(/role="tab"/);
  });

  it('языки приходят пропсами (мультитенантность), без дефолта-маски', () => {
    expect(src).toMatch(/locales:\s*readonly string\[\]/);
    expect(src).toMatch(/defaultLocale:\s*string/);
    expect(src).not.toMatch(/locales\s*=\s*\[/);
    expect(src).not.toMatch(/defaultLocale\s*=\s*'/);
  });

  it('антипаттерн запрещён: переводы уходят наверх вместе с content, а не теряются', () => {
    // onSave принимает ДВА аргумента (content + переводы).
    expect(src).toMatch(/onSave:\s*\(\s*content[^)]*translations/);
    expect(src).toMatch(/onSave\(\s*[\w.]+[\s\S]{0,120}?translations/);
    // Состояние переводов реально существует в форме.
    expect(src).toMatch(/setTr|setTranslations/);
  });

  it('уже сохранённые переводы подставляются в форму (иначе правка их затрёт)', () => {
    expect(src).toContain('sectionTranslationsFormState');
    expect(src).toContain('initialTranslations');
  });
});

describe('guard: редактор секций передаёт переводы в Server Action', () => {
  const src = read(SECTION_EDITOR);

  it('оба вызова upsert (добавление и правка) несут блок translations', () => {
    const calls = src.match(/upsertCmsSectionAction\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatch(/translations/);
    }
  });

  it('существующий оверлей секции доезжает до формы', () => {
    expect(src).toMatch(/initialTranslations=\{/);
    expect(src).toMatch(/section\.translations/);
  });

  it('языки магазина прокинуты в редактор пропсами', () => {
    expect(src).toMatch(/locales:\s*readonly string\[\]/);
    expect(src).toMatch(/defaultLocale:\s*string/);
  });
});

describe('guard: карточка страницы даёт редактору секций языки магазина', () => {
  const src = read(PAGE_FORM);

  it('<SectionEditor> получает locales и defaultLocale', () => {
    const mount = src.match(/<SectionEditor[\s\S]*?\/>/);
    expect(mount).not.toBeNull();
    expect(mount![0]).toMatch(/locales=\{/);
    expect(mount![0]).toMatch(/defaultLocale=\{/);
  });
});

describe('guard: upsertCmsSection реально пишет колонку translations', () => {
  const src = read(ACTIONS);
  const upsert = src.slice(
    src.indexOf('export const upsertCmsSection'),
    src.indexOf('export const reorderCmsSections'),
  );

  it('фрагмент upsertCmsSection найден', () => {
    expect(upsert.length).toBeGreaterThan(200);
  });

  it('переводы резолвятся серверным whitelist-резолвером с конфигом языков магазина', () => {
    expect(upsert).toContain('resolveSectionTranslationsUpdate');
    expect(upsert).toContain('getLocaleConfig');
    expect(upsert).toContain('existingSectionTranslations');
  });

  it('колонка translations есть и в списке INSERT, и в ветке ON CONFLICT DO UPDATE', () => {
    const insertCols = upsert.match(/INSERT INTO cms_page_sections\s*\(([\s\S]*?)\)/);
    expect(insertCols).not.toBeNull();
    expect(insertCols![1]).toContain('translations');

    const onConflict = upsert.slice(upsert.indexOf('ON CONFLICT'));
    expect(onConflict).toMatch(/translations\s*=/);
  });

  it('антипаттерн запрещён: колонка не пишется безусловно из прочитанного значения', () => {
    // provided=false → колонку не трогаем (иначе параллельная правка перевода
    // была бы затёрта прочитанным ранее снимком).
    const onConflict = upsert.slice(upsert.indexOf('ON CONFLICT'));
    expect(onConflict).toMatch(/translations\s*=\s*CASE WHEN/);
    expect(onConflict).toMatch(/ELSE cms_page_sections\.translations END/);
  });
});

describe('guard: схема входа секции принимает переводы', () => {
  const src = read(SCHEMAS);

  it('CmsSectionInputSchema несёт блок translations', () => {
    const schema = src.match(/CmsSectionInputSchema = z\.object\(\{[\s\S]*?\}\);/);
    expect(schema).not.toBeNull();
    expect(schema![0]).toContain('translations');
    expect(schema![0]).toContain('translationsBlockSchema');
  });
});
