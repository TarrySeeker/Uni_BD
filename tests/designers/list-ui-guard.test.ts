import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD (вёрстка/навигация раздела «Дизайнеры»). Тестов React-компонентов в проекте
// нет (vitest environment 'node'), поэтому сторожим исходники чтением — как в
// tests/admin/leads-table-layout.test.ts.
//
// Стережём два регресса волны 1:
//   C1 — из подзаголовка выпала подсказка «Можно оставить пустым» (её вырезали ради
//        счётчика «Найдено: N», хотя помещаются обе фразы);
//   C2 — возврат в список уходил на ГОЛЫЙ /admin/catalog/designers, теряя ?search/?sort.

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const pageSrc = () => read('app/admin/(panel)/catalog/designers/page.tsx');
const formSrc = () => read('app/admin/(panel)/catalog/_components/DesignerForm.tsx');

/** Значение пропа `subtitle` у <PageHeader> (шаблонная строка или литерал). */
function subtitle(src: string): string {
  const m = src.match(/subtitle=\{?[`"]([^`"]*)[`"]\}?/);
  expect(m, 'в page.tsx не найден subtitle у PageHeader').not.toBeNull();
  return m![1];
}

describe('C1: подзаголовок раздела «Дизайнеры»', () => {
  it('содержит И подсказку о необязательности раздела, И счётчик найденного', () => {
    const s = subtitle(pageSrc());
    expect(s).toContain('Можно оставить пустым');
    expect(s).toContain('Найдено:');
    // Счётчик обязан быть живым (из данных), а не забитым числом.
    expect(s).toMatch(/Найдено:\s*\$\{items\.length\}/);
  });
});

describe('C2: возврат в список сохраняет параметры списка', () => {
  it('форма строит адреса через buildDesignerHref, а не голыми литералами', () => {
    const src = formSrc();
    expect(src).toContain('buildDesignerHref');
    expect(src).toContain('useSearchParams');
    // Антипаттерн: переход на список/карточку в обход хелпера.
    expect(src).not.toMatch(/router\.push\(\s*['"]\/admin\/catalog\/designers['"]\s*\)/);
    expect(src).not.toMatch(/router\.push\(\s*`\/admin\/catalog\/designers\/\$\{[^}]+\}`\s*\)/);
  });

  it('ссылка «Создать дизайнера» уносит параметры списка в форму', () => {
    const src = pageSrc();
    expect(src).toContain('buildDesignerHref');
    expect(src).not.toMatch(/href="\/admin\/catalog\/designers\/new"/);
  });

  it('«Сбросить» остаётся голой ссылкой — это её смысл', () => {
    expect(pageSrc()).toMatch(/href="\/admin\/catalog\/designers"/);
  });
});
