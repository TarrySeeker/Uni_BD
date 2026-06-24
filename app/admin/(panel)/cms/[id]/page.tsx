import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getCmsPageById } from '@/lib/cms/repository';

import { Forbidden } from '../../_components/Forbidden';
import { guardCms } from '../_components/guard';
import { PageForm } from '../_components/PageForm';
import { StatusBadge } from '../_components/StatusBadge';

/**
 * Карточка CMS-страницы (docs/11 §5.1.5, пакет 5.C-3). Чтение — cms.read; правки/
 * публикация/секции — cms.write (проверяется и в Server Action). Если права записи
 * нет — форма рендерится, но сервер отклонит мутацию (двойная защита).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function CmsPageDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardCms('cms.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="cms (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const page = await getCmsPageById(id);
  if (!page) {
    notFound();
  }

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/cms" className="text-blue-700 hover:underline">
          Контент
        </Link>{' '}
        / {page.title}
      </nav>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">{page.title}</h1>
        <StatusBadge status={page.status} />
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Slug: <code className="text-xs">{page.slug}</code>
      </p>

      <div className="mt-6">
        <PageForm page={page} />
      </div>
    </div>
  );
}
