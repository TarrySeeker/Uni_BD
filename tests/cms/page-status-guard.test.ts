import { describe, expect, it } from 'vitest';

import {
  CmsPageCreateSchema,
  CmsPageUpdateSchema,
  cmsPageStatusSchema,
  CmsPageListFilterSchema,
} from '@/lib/cms/schemas';

/**
 * Тесты бага B волны 5 (MAJOR, CMS): create/update НЕ должны публиковать страницу
 * в обход publishCmsPage.
 *
 * Витрина отдаёт страницу по status='published' (getPublishedCmsPageBySlug/
 * listPublishedCmsPages). Корректную публикацию делает ТОЛЬКО выделенная
 * publishCmsPage: транзакция status='published' + published_at=COALESCE(...,now())
 * + снимок в cms_page_revisions (миграции 0022/0023). Поэтому create/update со
 * status='published' нарушали бы инвариант: страница становилась публичной с
 * published_at=NULL и БЕЗ ревизии (а ORDER BY published_at DESC NULLS LAST ставил
 * бы её в конец навигации).
 *
 * Вариант Б (выбран — в UI есть выделенная кнопка «Опубликовать»/«Снять с
 * публикации»): create/update принимают только 'draft'/'archived'. Публикация —
 * исключительно через publishCmsPage. cmsPageStatusSchema (полная триада)
 * остаётся для фильтра списка (CmsPageListFilterSchema).
 */

describe('cms — create/update НЕ публикуют (вариант Б)', () => {
  it("CmsPageCreateSchema: status='published' отвергается", () => {
    const r = CmsPageCreateSchema.safeParse({ title: 'О компании', status: 'published' });
    expect(r.success).toBe(false);
  });

  it("CmsPageUpdateSchema: status='published' отвергается", () => {
    const r = CmsPageUpdateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'published',
    });
    expect(r.success).toBe(false);
  });

  it("CmsPageCreateSchema: 'draft' и 'archived' допустимы", () => {
    expect(CmsPageCreateSchema.safeParse({ title: 'X', status: 'draft' }).success).toBe(true);
    expect(CmsPageCreateSchema.safeParse({ title: 'X', status: 'archived' }).success).toBe(true);
  });

  it("CmsPageUpdateSchema: 'draft' и 'archived' допустимы (снятие/архивирование)", () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(CmsPageUpdateSchema.safeParse({ id, status: 'draft' }).success).toBe(true);
    expect(CmsPageUpdateSchema.safeParse({ id, status: 'archived' }).success).toBe(true);
  });

  it('status опционален (create/update без статуса валидны)', () => {
    expect(CmsPageCreateSchema.safeParse({ title: 'X' }).success).toBe(true);
    expect(
      CmsPageUpdateSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });

  it("неизвестный статус ('live') отвергается в create/update", () => {
    expect(CmsPageCreateSchema.safeParse({ title: 'X', status: 'live' }).success).toBe(false);
    expect(
      CmsPageUpdateSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'live',
      }).success,
    ).toBe(false);
  });

  it("cmsPageStatusSchema (полная триада) сохранена для фильтра списка — 'published' допустим", () => {
    expect(cmsPageStatusSchema.safeParse('published').success).toBe(true);
    expect(CmsPageListFilterSchema.safeParse({ status: 'published' }).success).toBe(true);
  });
});
