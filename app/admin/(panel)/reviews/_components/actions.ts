'use server';

import {
  setReviewStatus,
  replyToReview,
  deleteReviewAction,
} from '@/lib/reviews/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions отзывов (lib/reviews/actions) —
 * образец leads/_components/actions. Guard (reviews.write), assertReviewsEnabled,
 * Zod-валидация, машина статусов, санитизация reply, i18n-оверлей, аудит и
 * инвалидация — всё внутри defineAction в lib/reviews/actions; здесь НЕ дублируется.
 */

export async function setReviewStatusAction(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return setReviewStatus(input) as Promise<
    ActionResult<{ id: string; status: string }>
  >;
}

export async function replyToReviewAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return replyToReview(input);
}

export async function deleteReviewAdminAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return deleteReviewAction(input);
}
