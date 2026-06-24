import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Поведенческое покрытие defaultHasPublishedCmsPages (раньше функция тестами не
 * покрывалась — экшен-тесты инъектят мок hasPublishedCmsPages).
 *
 * Контракт: вернуть true, если есть опубликованная CMS-страница; false иначе;
 * толерантность к отсутствию таблицы cms_pages (модуль 5.C-1 мог быть не накатан) —
 * ошибка чтения ловится catch → false. sql замокан.
 *
 * NB (цикл 8): аудит пометил здешний SQL `SELECT EXISTS(...) AS exists WHERE
 * to_regclass(...)` как «невалидный (WHERE без FROM)» — это ЛОЖНАЯ находка:
 * PostgreSQL 15 ДОПУСКАЕТ WHERE без FROM (`SELECT 1 WHERE true`→1 строка,
 * `WHERE false`→0 строк), проверено вживую против БД стенда. Запрос корректен.
 */

const h = vi.hoisted(() => {
  const state = { rows: [{ exists: true }] as unknown[], throwIt: false };
  const sql = vi.fn(() => {
    if (state.throwIt) {
      return Promise.reject(new Error('relation "cms_pages" does not exist'));
    }
    return Promise.resolve(state.rows);
  });
  return { state, sql };
});

vi.mock('@/lib/db/client', () => ({ sql: h.sql }));

import { defaultHasPublishedCmsPages } from '@/lib/settings/action-factory';

const { state } = h;

beforeEach(() => {
  state.rows = [{ exists: true }];
  state.throwIt = false;
  h.sql.mockClear();
});

describe('settings/action-factory — defaultHasPublishedCmsPages (поведение)', () => {
  it('EXISTS вернул exists:true → true (предупреждение покажется при выключении cms)', async () => {
    state.rows = [{ exists: true }];
    expect(await defaultHasPublishedCmsPages()).toBe(true);
  });

  it('EXISTS вернул exists:false → false', async () => {
    state.rows = [{ exists: false }];
    expect(await defaultHasPublishedCmsPages()).toBe(false);
  });

  it('таблицы нет (WHERE to_regclass отфильтровал) → пустой результат → false', async () => {
    state.rows = [];
    expect(await defaultHasPublishedCmsPages()).toBe(false);
  });

  it('ошибка чтения (иное) → catch → false (толерантность)', async () => {
    state.throwIt = true;
    expect(await defaultHasPublishedCmsPages()).toBe(false);
  });
});
