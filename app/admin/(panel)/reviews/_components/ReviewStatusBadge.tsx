'use client';

import { useTranslations } from 'next-intl';

import { isReviewStatus, reviewStatusLabel } from '@/lib/reviews/status';
import type { ReviewStatus } from '@/lib/reviews/types';

/**
 * Бейдж статуса отзыва (pending/approved/rejected). Презентационный компонент —
 * образец LeadStatusBadge. Неизвестный статус рисуется нейтрально.
 */
const CLASSES: Record<ReviewStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-100 text-gray-600',
};

export function ReviewStatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  const cls = isReviewStatus(status) ? CLASSES[status] : 'bg-gray-100 text-gray-600';
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {reviewStatusLabel(status, t)}
    </span>
  );
}
