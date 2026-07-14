/**
 * Публичный API среза «Новости» (docs/24 §3). Реэкспорт домена.
 * Actions намеренно НЕ реэкспортируются здесь ('use server'-модуль импортируется
 * напрямую из admin form-actions / storefront не использует мутации).
 */

export type {
  NewsArticle,
  NewsListRow,
  NewsStatus,
} from './types';
export { NEWS_STATUSES } from './types';
export { NEWS_TRANSLATABLE_FIELDS } from './fields';
export { canTransitionNews, nextNewsStatuses } from './status';
export { NewsError, type NewsErrorCode } from './errors';
export {
  listNews,
  countNews,
  getNewsById,
  getNewsBySlug,
  getPublishedNews,
  getPublishedNewsBySlug,
  mapNews,
  mapNewsListRow,
  type NewsListFilter,
  type PublishedNewsFilter,
} from './repository';
export {
  NewsCreateSchema,
  NewsUpdateSchema,
  NewsIdSchema,
  NewsSetStatusSchema,
  NewsListFilterSchema,
  newsStatusSchema,
} from './schemas';
