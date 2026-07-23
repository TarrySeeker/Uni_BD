import { describe, expect, it } from 'vitest';

import {
  DESIGNER_LIST_PATH,
  buildDesignerHref,
} from '../../app/admin/(panel)/catalog/_components/designer-list-url';

// ЮНИТ: возврат в список дизайнеров с сохранением его параметров.
//
// ДЕФЕКТ: состояние списка (поиск + порядок) живёт в query (?search=…&sort=…), а
// «Отмена» в форме и переход после создания уходили на голый /admin/catalog/designers —
// владелец, нашедший дизайнера поиском, терял и запрос, и порядок.
//
// Функция чистая (строка query → строка href): форма остаётся клиентской и не
// начинает зависеть от серверных данных, а логика проверяется без React.

describe('buildDesignerHref', () => {
  it('пустой query → голый путь без «?»', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, '')).toBe(DESIGNER_LIST_PATH);
    expect(buildDesignerHref(DESIGNER_LIST_PATH, null)).toBe(DESIGNER_LIST_PATH);
    expect(buildDesignerHref(DESIGNER_LIST_PATH, undefined)).toBe(DESIGNER_LIST_PATH);
    expect(buildDesignerHref(DESIGNER_LIST_PATH, '?')).toBe(DESIGNER_LIST_PATH);
  });

  it('сохраняет поиск и допустимый порядок', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'search=Иванов&sort=name_desc')).toBe(
      `${DESIGNER_LIST_PATH}?search=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2&sort=name_desc`,
    );
  });

  it('работает с ведущим «?» (URLSearchParams.toString() его не даёт, но URL — да)', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, '?sort=manual')).toBe(
      `${DESIGNER_LIST_PATH}?sort=manual`,
    );
  });

  it('порядок параметров детерминирован: сначала search, потом sort', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'sort=name_asc&search=ann')).toBe(
      `${DESIGNER_LIST_PATH}?search=ann&sort=name_asc`,
    );
  });

  it('неизвестные параметры не тащатся в возврат', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'page=3&utm_source=mail&redirect=//evil.tld')).toBe(
      DESIGNER_LIST_PATH,
    );
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'search=ann&utm_source=mail')).toBe(
      `${DESIGNER_LIST_PATH}?search=ann`,
    );
  });

  it('мусорный sort отбрасывается (белый список DESIGNER_SORTS), а не переносится как есть', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'sort=DROP')).toBe(DESIGNER_LIST_PATH);
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'search=ann&sort=name_ASC')).toBe(
      `${DESIGNER_LIST_PATH}?search=ann`,
    );
  });

  it('пустой/пробельный search не даёт мусорного «?search=»', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'search=')).toBe(DESIGNER_LIST_PATH);
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'search=%20%20&sort=manual')).toBe(
      `${DESIGNER_LIST_PATH}?sort=manual`,
    );
  });

  it('повторённый параметр берётся один раз (как в parseDesignerListParams)', () => {
    expect(buildDesignerHref(DESIGNER_LIST_PATH, 'sort=name_asc&sort=name_desc')).toBe(
      `${DESIGNER_LIST_PATH}?sort=name_asc`,
    );
  });

  it('работает не только для списка: карточка дизайнера получает те же параметры', () => {
    expect(buildDesignerHref(`${DESIGNER_LIST_PATH}/42`, 'search=ann&sort=name_desc')).toBe(
      `${DESIGNER_LIST_PATH}/42?search=ann&sort=name_desc`,
    );
  });
});
