/**
 * Публичный API среза «Отзывы» (docs/24 §4). Реэкспорт домена.
 * Actions намеренно НЕ реэкспортируются здесь ('use server'-модуль импортируется
 * напрямую из admin form-actions; storefront submit не использует admin-мутации).
 */

export type {
  Review,
  ReviewModerationRow,
  ApprovedReviewRow,
  ReviewAggregate,
  ReviewStatus,
} from './types';
export { REVIEW_STATUSES } from './types';
export { REVIEW_TRANSLATABLE_FIELDS } from './fields';
export {
  REVIEW_STATUS_TRANSITIONS,
  REVIEW_STATUS_LABELS,
  isReviewStatus,
  reviewStatusLabel,
  canReviewTransition,
  nextReviewStatuses,
} from './status';
export { sanitizeReviewBody } from './sanitize';
export { ReviewError, type ReviewErrorCode } from './errors';
export {
  insertReview,
  productExists,
  findCustomerIdByEmail,
  listApprovedByProduct,
  getProductRatingAggregate,
  listReviewsForModeration,
  countReviews,
  countReviewsByStatus,
  getReviewById,
  updateReviewStatus,
  setReviewReply,
  deleteReview,
  mapReview,
  mapReviewModerationRow,
  mapApprovedReviewRow,
  type InsertReviewInput,
  type ReviewModerationFilter,
} from './repository';
export {
  ReviewSubmitSchema,
  ReviewStatusInputSchema,
  ReviewReplyInputSchema,
  ReviewIdSchema,
  ReviewListFilterSchema,
  reviewStatusSchema,
  type ReviewSubmitInput,
} from './schemas';
