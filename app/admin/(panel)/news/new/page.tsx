import Link from 'next/link';

import { getLocaleConfig } from '@/lib/i18n';

import { Forbidden } from '../../_components/Forbidden';
import { guardNews } from '../_components/guard';
import { NewsForm } from '../_components/NewsForm';

/**
 * Создание новости (docs/24 §3). Доступ к странице — news.write; сам сабмит
 * создаёт через createNews (news.write + assertNewsEnabled).
 *
 * force-dynamic: читает cookies/сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

export default async function NewNewsPage() {
  const guard = await guardNews('news.write');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="news (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const localeConfig = await getLocaleConfig();

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/news" className="text-blue-700 hover:underline">Новости</Link>{' '}
        / Новая новость
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">Новая новость</h1>
      <p className="mt-1 text-sm text-gray-600">
        Заполните заголовок, текст и SEO, затем создайте новость. Переводы (EN/FR) и
        публикация станут доступны после создания.
      </p>

      <div className="mt-6">
        <NewsForm
          article={null}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>
    </div>
  );
}
