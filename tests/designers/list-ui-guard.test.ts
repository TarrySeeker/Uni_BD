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

/**
 * ru-значение ключа подзаголовка из каталога сообщений. После i18n-переноса текст
 * подзаголовка живёт в messages/ru.json (page.tsx рендерит его через t(...)), но
 * инвариант C1 неизменен: подсказка о необязательности + живой счётчик найденного.
 */
function ruSubtitle(): string {
  const ru = JSON.parse(read('messages/ru.json')) as {
    catalog: { designer: { listSubtitle: string } };
  };
  return ru.catalog.designer.listSubtitle;
}

describe('C1: подзаголовок раздела «Дизайнеры»', () => {
  it('ru-текст подзаголовка содержит И подсказку о необязательности, И счётчик найденного', () => {
    const s = ruSubtitle();
    expect(s).toContain('Можно оставить пустым');
    expect(s).toContain('Найдено:');
    // Счётчик — ICU-плейсхолдер {count}, а не забитое число.
    expect(s).toMatch(/Найдено:\s*\{count\}/);
  });

  it('page.tsx рендерит подзаголовок через ключ перевода с ЖИВЫМ счётчиком', () => {
    const src = pageSrc();
    expect(src).toContain("'catalog.designer.listSubtitle'");
    // Счётчик обязан быть живым (из данных), а не забитым числом.
    expect(src).toMatch(/count:\s*items\.length/);
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
