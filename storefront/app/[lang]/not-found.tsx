'use client';

/**
 * 404 витрины carre внутри сегмента локали. Рендерится внутри [lang]/layout.tsx
 * (шапка/меню/футер сохраняются). notFound() из страниц (товар/категория/CMS не
 * найдены) приводит сюда. Ссылка «в каталог» ведёт на корень (ru) — на клиенте
 * middleware/навигация сохранит текущий префикс через обычные внутренние ссылки.
 *
 * not-found.tsx не получает params (ограничение Next), поэтому локаль берём из
 * pathname (usePathname + stripLocale) — как переключатель языка в шапке.
 */

import { usePathname } from 'next/navigation';
import { localizedHref, stripLocale } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';

export default function NotFound() {
  const pathname = usePathname() || '/';
  const { locale } = stripLocale(pathname);
  const dict = getDictionary(locale);

  return (
    <div className="sf-cms-page">
      <div className="page-title">
        <h1>404</h1>
      </div>
      <div className="sf-empty">
        {dict.notFound.text}{' '}
        <a href={localizedHref('/catalog', locale)}>{dict.common.goToCatalog}</a>
      </div>
    </div>
  );
}
