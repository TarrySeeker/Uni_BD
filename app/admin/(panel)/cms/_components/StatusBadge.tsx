import type { CmsPageStatus } from '@/lib/cms/types';

/**
 * Бейдж статуса CMS-страницы (триада draft/published/archived). Чистый
 * презентационный компонент — образец catalog Badges.
 */
const LABELS: Record<CmsPageStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  archived: 'В архиве',
};

const CLASSES: Record<CmsPageStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-amber-100 text-amber-800',
};

export function StatusBadge({ status }: { status: CmsPageStatus }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
