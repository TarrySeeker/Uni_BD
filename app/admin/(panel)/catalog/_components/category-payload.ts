import type { CategoryUpdateInput } from '@/lib/catalog/schemas';
import type { SeoFieldsetValue } from '../../_components/SeoFieldset';

/**
 * Сборка payload формы редактирования категории (тупик C13 аудита — SEO/OG-поля
 * категории недоступны в UI).
 *
 * Чистая функция без React/'use server' — общий источник правды для клиентской
 * формы CategoryForm и для теста (tests/catalog/category-form.test.ts). Возвращает
 * объект, который затем валидируется CategoryUpdateSchema ВНУТРИ defineAction
 * (updateCategory) — здесь Zod НЕ дублируется, только нормализуем строки формы
 * (trim, пустое→undefined), зеркально BrandForm.save().
 */

/** Сырые поля формы редактирования категории. */
export interface CategoryFormValues {
  name: string;
  slug: string;
  description: string;
  isActive: boolean;
  /** Расширенные SEO/OG-поля (общий SeoFieldset, как у бренда/товара). */
  seo: SeoFieldsetValue;
}

/** Пустую/пробельную строку приводим к undefined (поле не передаём). */
function blankToUndefined(v: string): string | undefined {
  const t = v.trim();
  return t === '' ? undefined : t;
}

/**
 * Форма категории → вход updateCategory (CategoryUpdateSchema).
 * Расширенные SEO/OG-поля (ogTitle/ogDescription/ogImageKey/canonicalUrl/noindex)
 * принимает именно Update-схема (seoEntityFields), как у бренда/товара.
 */
export function buildCategoryUpdateInput(
  id: string,
  v: CategoryFormValues,
): Partial<CategoryUpdateInput> & { id: string } {
  return {
    id,
    name: v.name.trim(),
    slug: blankToUndefined(v.slug),
    description: v.description,
    isActive: v.isActive,
    seoTitle: blankToUndefined(v.seo.seoTitle),
    seoDescription: blankToUndefined(v.seo.seoDescription),
    ogTitle: blankToUndefined(v.seo.ogTitle),
    ogDescription: blankToUndefined(v.seo.ogDescription),
    ogImageKey: blankToUndefined(v.seo.ogImageKey),
    canonicalUrl: blankToUndefined(v.seo.canonicalUrl),
    noindex: v.seo.noindex,
  };
}
