import Link from 'next/link';

import { Forbidden } from '../../_components/Forbidden';
import { guardCms } from '../_components/guard';
import { PageForm } from '../_components/PageForm';

/**
 * Создание CMS-страницы (docs/11 §5.1.5, пакет 5.C-3). Доступ к странице —
 * cms.read; сам сабмит создаёт через createCmsPage (cms.write + assertCmsEnabled).
 *
 * force-dynamic: читает cookies/сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewCmsPage() {
  const guard = await guardCms('cms.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="cms (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/cms" className="text-blue-700 hover:underline">
          Контент
        </Link>{' '}
        / Новая страница
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">Новая страница</h1>
      <p className="mt-1 text-sm text-gray-600">
        Заполните заголовок и SEO, затем создайте страницу. Секции (hero, текст,
        баннеры, сетка товаров и др.) станут доступны после создания.
      </p>

      <div className="mt-6">
        <PageForm page={null} />
      </div>
    </div>
  );
}
