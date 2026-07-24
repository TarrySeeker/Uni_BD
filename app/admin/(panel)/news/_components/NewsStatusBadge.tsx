import { getTranslations } from 'next-intl/server';

import type { NewsStatus } from '@/lib/news/types';

/**
 * Бейдж статуса новости (триада draft/published/archived). Чистый презентационный
 * компонент — образец cms StatusBadge.
 */
const LABEL_KEYS: Record<NewsStatus, string> = {
  draft: 'news.newsStatusBadge.draft',
  published: 'news.newsStatusBadge.published',
  archived: 'news.newsStatusBadge.archived',
};

const CLASSES: Record<NewsStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-amber-100 text-amber-800',
};

export async function NewsStatusBadge({ status }: { status: NewsStatus }) {
  const t = await getTranslations();
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CLASSES[status]}`}
    >
      {t(LABEL_KEYS[status])}
    </span>
  );
}
