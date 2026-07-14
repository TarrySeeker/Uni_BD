/**
 * Slug-логика новостей (docs/24 §3). ПЕРЕИСПОЛЬЗУЕМ (не дублируем) алгоритм
 * каталога/CMS — единый источник правды о ЧПУ для всей платформы. Реэкспорт,
 * а не копия, чтобы поведение не разъезжалось.
 */

export {
  slugify,
  slugifyOrFallback,
  isValidSlug,
  uniquifySlug,
} from '@/lib/catalog/slug';
