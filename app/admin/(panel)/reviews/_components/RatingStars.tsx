/**
 * Презентационный рейтинг звёздами 1..5 (для таблицы модерации/карточки).
 * Чистый компонент без состояния. Значение вне 1..5 клампится.
 */
export function RatingStars({ value }: { value: number }) {
  const n = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span
      className="whitespace-nowrap text-amber-500"
      aria-label={`Рейтинг ${n} из 5`}
      title={`${n}/5`}
    >
      {'★'.repeat(n)}
      <span className="text-gray-300">{'★'.repeat(5 - n)}</span>
    </span>
  );
}
