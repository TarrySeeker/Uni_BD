import { getTranslations } from 'next-intl/server';

import type { CmsPageStatus } from '@/lib/cms/types';

/**
 * Бейдж статуса CMS-страницы (триада draft/published/archived). Чистый
 * презентационный компонент — образец catalog Badges.
 */
const CLASSES: Record<CmsPageStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-amber-100 text-amber-800',
};

export async function StatusBadge({ status }: { status: CmsPageStatus }) {
  const t = await getTranslations();
  const labels: Record<CmsPageStatus, string> = {
    draft: t('common.states.draft'),
    published: t('common.states.published'),
    archived: t('cms.statusBadge.archived'),
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}
    >
      {labels[status]}
    </span>
  );
}
