import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getNewsById } from '@/lib/news/repository';
import { can } from '@/lib/auth/rbac';
import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../_components/Forbidden';
import { guardNews } from '../_components/guard';
import { NewsForm } from '../_components/NewsForm';
import { NewsStatusBadge } from '../_components/NewsStatusBadge';

/**
 * Карточка новости (docs/24 §3). Чтение — news.read; правки/публикация — news.write
 * (проверяется и в Server Action, двойная защита). Без права записи форма — read-only.
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewsDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardNews('news.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="news (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const [article, localeConfig] = await Promise.all([getNewsById(id), getLocaleConfig()]);
  if (!article) {
    notFound();
  }

  const canWrite = can(guard.user, 'news.write');

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/news" className="text-blue-700 hover:underline">Новости</Link>{' '}
        / {article.title}
      </nav>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">{article.title}</h1>
        <NewsStatusBadge status={article.status} />
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Slug: <code className="text-xs">{article.slug}</code>
      </p>

      <div className="mt-6">
        <NewsForm
          article={article}
          canWrite={canWrite}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
