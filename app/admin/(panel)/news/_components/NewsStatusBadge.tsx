import type { NewsStatus } from '@/lib/news/types';

/**
 * Бейдж статуса новости (триада draft/published/archived). Чистый презентационный
 * компонент — образец cms StatusBadge.
 */
const LABELS: Record<NewsStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  archived: 'В архиве',
};

const CLASSES: Record<NewsStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-amber-100 text-amber-800',
};

export function NewsStatusBadge({ status }: { status: NewsStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
