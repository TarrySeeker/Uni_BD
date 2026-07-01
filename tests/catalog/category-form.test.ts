import { describe, expect, it } from 'vitest';

import {
  buildCategoryUpdateInput,
  type CategoryFormValues,
} from '@/app/admin/(panel)/catalog/_components/category-payload';
import { CategoryUpdateSchema } from '@/lib/catalog/schemas';
import { EMPTY_SEO_FIELDSET } from '@/app/admin/(panel)/_components/SeoFieldset';

// ЮНИТ: сборка payload формы редактирования категории (тупик C13) — чистая
// функция, общая для CategoryForm и теста. Проверяем без БД/Next: проброс
// SEO/OG-полей (ogTitle/ogDescription/canonicalUrl/noindex), trim/пустое→undefined
// и совместимость с CategoryUpdateSchema (тот же источник правды, что в Action).

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';

function form(overrides: Partial<CategoryFormValues> = {}): CategoryFormValues {
  return {
    name: 'Кресла',
    slug: 'kresla',
    description: '',
    isActive: true,
    seo: { ...EMPTY_SEO_FIELDSET },
    ...overrides,
  };
}

describe('buildCategoryUpdateInput (C13)', () => {
  it('прокидывает id + SEO/OG-поля, проходит CategoryUpdateSchema', () => {
    const payload = buildCategoryUpdateInput(
      CATEGORY_ID,
      form({
        seo: {
          seoTitle: 'Кресла — заголовок',
          seoDescription: 'Описание',
          ogTitle: 'OG заголовок',
          ogDescription: 'OG описание',
          ogImageKey: 'categories/1/og.webp',
          canonicalUrl: 'https://shop.example/catalog/kresla',
          noindex: true,
        },
      }),
    );
    expect(payload.id).toBe(CATEGORY_ID);
    expect(payload.ogTitle).toBe('OG заголовок');
    expect(payload.ogDescription).toBe('OG описание');
    expect(payload.ogImageKey).toBe('categories/1/og.webp');
    expect(payload.canonicalUrl).toBe('https://shop.example/catalog/kresla');
    expect(payload.noindex).toBe(true);

    const res = CategoryUpdateSchema.safeParse(payload);
    expect(res.success, JSON.stringify(res)).toBe(true);
  });

  it('пустые SEO-строки → undefined (поля не перетираются)', () => {
    const payload = buildCategoryUpdateInput(CATEGORY_ID, form());
    expect(payload.seoTitle).toBeUndefined();
    expect(payload.ogTitle).toBeUndefined();
    expect(payload.canonicalUrl).toBeUndefined();
    expect(payload.noindex).toBe(false);
    expect(CategoryUpdateSchema.safeParse(payload).success).toBe(true);
  });

  it('isActive=false прокидывается (C4/C13 — скрыть категорию из формы)', () => {
    const payload = buildCategoryUpdateInput(CATEGORY_ID, form({ isActive: false }));
    expect(payload.isActive).toBe(false);
  });

  it('пустой slug → undefined; имя тримится', () => {
    const payload = buildCategoryUpdateInput(CATEGORY_ID, form({ slug: '  ', name: '  Кресла  ' }));
    expect(payload.slug).toBeUndefined();
    expect(payload.name).toBe('Кресла');
  });

  it('невалидный canonicalUrl (без схемы/ведущего «/») отклоняется схемой', () => {
    const payload = buildCategoryUpdateInput(
      CATEGORY_ID,
      form({ seo: { ...EMPTY_SEO_FIELDSET, canonicalUrl: 'javascript:alert(1)' } }),
    );
    expect(CategoryUpdateSchema.safeParse(payload).success).toBe(false);
  });
});
