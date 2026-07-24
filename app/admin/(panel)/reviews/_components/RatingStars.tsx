import { getTranslations } from 'next-intl/server';

/**
 * Презентационный рейтинг звёздами 1..5 (для таблицы модерации/карточки).
 * Чистый компонент без состояния. Значение вне 1..5 клампится.
 */
export async function RatingStars({ value }: { value: number }) {
  const t = await getTranslations();
  const n = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span
      className="whitespace-nowrap text-amber-500"
      aria-label={t('reviews.ratingStars.ariaLabel', { n })}
      title={`${n}/5`}
    >
      {'★'.repeat(n)}
      <span className="text-gray-300">{'★'.repeat(5 - n)}</span>
    </span>
  );
}
