import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getReviewById } from '@/lib/reviews/repository';
import { can } from '@/lib/auth/rbac';
import { getLocaleConfig } from '@/lib/i18n';
import { formatDateTime } from '@/lib/admin/order-format';
import { getShopTimeZone } from '@/lib/admin/timezone';

import { Forbidden } from '../../_components/Forbidden';
import { guardReviews } from '../_components/guard';
import { ReviewStatusBadge } from '../_components/ReviewStatusBadge';
import { RatingStars } from '../_components/RatingStars';
import { ReviewRowActions } from '../_components/ReviewRowActions';
import { ReviewReplyForm } from '../_components/ReviewReplyForm';

/**
 * Карточка отзыва (docs/24 §4). Чтение — reviews.read; модерация/ответ —
 * reviews.write (проверяется и в Server Action, двойная защита). Без права записи
 * форма ответа read-only.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function ReviewDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations();
  // Пояс магазина — один на всю админку (аудит major №26).
  const timeZone = await getShopTimeZone();
  const guard = await guardReviews('reviews.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('reviews.detailPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const [review, localeConfig] = await Promise.all([
    getReviewById(id),
    getLocaleConfig(),
  ]);
  if (!review) {
    notFound();
  }

  const canWrite = can(guard.user, 'reviews.write');

  return (
    <div className="max-w-3xl">
      <nav
        className="text-sm text-gray-500"
        aria-label={t('layout.breadcrumbs.ariaLabel')}
      >
        <Link href="/admin/reviews" className="text-blue-700 hover:underline">
          {t('nav.reviews')}
        </Link>{' '}
        / {review.authorName}
      </nav>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">
          {t('reviews.detailPage.title', { author: review.authorName })}
        </h1>
        <ReviewStatusBadge status={review.status} />
        <RatingStars value={review.rating} />
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">{t('reviews.detailPage.dateLabel')}</dt>
            <dd className="text-gray-800">{formatDateTime(review.createdAt, timeZone)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">
              {t('reviews.detailPage.productLabel')}
            </dt>
            <dd className="text-gray-800">
              <code>{review.productId}</code>
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <div className="text-gray-500 text-sm">
            {t('reviews.detailPage.reviewTextLabel')}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-gray-800">{review.body}</p>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="text-lg font-semibold text-gray-900">
          {t('reviews.detailPage.moderationHeading')}
        </h2>
        <div className="mt-2">
          <ReviewRowActions id={review.id} status={review.status} />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold text-gray-900">
          {t('reviews.detailPage.replyHeading')}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {t('reviews.detailPage.replyHelp')}
        </p>
        <div className="mt-3">
          <ReviewReplyForm
            id={review.id}
            reply={review.reply}
            translations={review.translations}
            locales={localeConfig.locales}
            defaultLocale={localeConfig.defaultLocale}
            canWrite={canWrite}
          />
        </div>
      </section>
    </div>
  );
}
