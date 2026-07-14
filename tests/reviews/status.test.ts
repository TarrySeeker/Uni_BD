import { describe, expect, it } from 'vitest';

import {
  canReviewTransition,
  nextReviewStatuses,
  isReviewStatus,
  reviewStatusLabel,
} from '@/lib/reviews/status';

/**
 * ЮНИТ (без БД): машина статусов модерации отзывов (docs/24 §4).
 * pending→approved/rejected; approved/rejected обратимы; X→X запрещён.
 */
describe('reviews/status — машина модерации', () => {
  it('pending → approved и pending → rejected разрешены', () => {
    expect(canReviewTransition('pending', 'approved')).toBe(true);
    expect(canReviewTransition('pending', 'rejected')).toBe(true);
  });

  it('approved/rejected можно вернуть в pending и переоценить', () => {
    expect(canReviewTransition('approved', 'rejected')).toBe(true);
    expect(canReviewTransition('approved', 'pending')).toBe(true);
    expect(canReviewTransition('rejected', 'approved')).toBe(true);
    expect(canReviewTransition('rejected', 'pending')).toBe(true);
  });

  it('X → X запрещён (нулевой переход)', () => {
    expect(canReviewTransition('pending', 'pending')).toBe(false);
    expect(canReviewTransition('approved', 'approved')).toBe(false);
    expect(canReviewTransition('rejected', 'rejected')).toBe(false);
  });

  it('неизвестные статусы → false', () => {
    expect(canReviewTransition('spam', 'approved')).toBe(false);
    expect(canReviewTransition('approved', 'deleted')).toBe(false);
  });

  it('nextReviewStatuses отдаёт допустимые переходы', () => {
    expect(nextReviewStatuses('pending')).toEqual(['approved', 'rejected']);
    expect(nextReviewStatuses('approved')).toEqual(['rejected', 'pending']);
    expect(nextReviewStatuses('unknown')).toEqual([]);
  });

  it('isReviewStatus / reviewStatusLabel', () => {
    expect(isReviewStatus('pending')).toBe(true);
    expect(isReviewStatus('nope')).toBe(false);
    expect(reviewStatusLabel('approved')).toBe('Одобрен');
    expect(reviewStatusLabel('mystery')).toBe('mystery');
  });
});
