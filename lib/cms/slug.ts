/**
 * Slug-логика CMS (docs/11 §5.1.3, инвариант 5.1).
 *
 * ПЕРЕИСПОЛЬЗУЕМ (не дублируем) алгоритм каталога: slugify/isValidSlug/
 * uniquifySlug — единый источник правды о ЧПУ для всей платформы. Реэкспорт,
 * а не копия, чтобы поведение CMS и каталога не разъезжалось.
 */

export {
  slugify,
  slugifyOrFallback,
  isValidSlug,
  uniquifySlug,
} from '@/lib/catalog/slug';
