/**
 * КОРНЕВОЙ 404 витрины — последний рубеж.
 *
 * 🔴 АУДИТ №33. Прежде этого файла НЕ существовало: единственный not-found жил в
 * `app/[lang]/not-found.tsx`, то есть ВНУТРИ сегмента локали. Любой запрос, не
 * попавший в этот сегмент, получал ГОЛУЮ англоязычную 404 самого Next — чёрный
 * текст «404 | This page could not be found» без шапки, футера и единой ссылки
 * обратно в магазин. Покупатель оказывался в тупике на чужом по языку экране.
 *
 * После правки middleware (routeDecision) в этот 404 попасть практически нечем:
 * каждый нормальный путь либо проходит с реальным префиксом локали, либо
 * переписывается в сегмент дефолтной локали (и получает ЛОКАЛИЗОВАННЫЙ 404 с
 * шапкой и футером из `[lang]/not-found.tsx`). Но «практически нечем» — не
 * «нечем»: сюда доходят пути, которые middleware сознательно не трогает (matcher
 * исключает `/api/*`, `/_next/*`, ассеты с расширением) и любые будущие маршруты
 * вне `[lang]`. На них витрина обязана отвечать своей страницей, а не заглушкой
 * фреймворка на английском.
 *
 * 🔴 Своя разметка <html>/<body> здесь ОБЯЗАТЕЛЬНА: этот файл лежит ВНЕ
 * `app/[lang]/layout.tsx`, а другого layout у витрины нет — обернуть его некому.
 * Отсюда же и ограничения: шапку/футер (им нужны категории и настройки из
 * Storefront API) не рендерим — на пути «страница не найдена» сетевой вызов может
 * упасть и превратить 404 в 500. Отдаём самодостаточный экран: стили витрины,
 * язык по умолчанию, ссылки в каталог и на главную.
 *
 * Язык — DEFAULT_LOCALE: локаль запроса здесь неизвестна (params нет, а pathname
 * в серверном not-found недоступен), и это ровно тот же язык, на котором витрина
 * отвечает по корню. Текст — из словаря витрины, не хардкодом.
 */

import { DEFAULT_LOCALE, HTML_LANG, localizedHref } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';

export default function RootNotFound() {
  const locale = DEFAULT_LOCALE;
  const dict = getDictionary(locale);

  return (
    <html lang={HTML_LANG[locale]}>
      <body className="page--main">
        {/* Тот же собранный дизайн, что и у остальной витрины (см. [lang]/layout). */}
        <link rel="stylesheet" href="/dist/app.css" precedence="default" />
        <link rel="stylesheet" href="/storefront.css" precedence="default" />

        <div className="main-content main-content--pt main-content--pb">
          <div className="sf-cms-page">
            <div className="page-title">
              <h1>404</h1>
            </div>
            <div className="sf-empty">
              {dict.notFound.text}{' '}
              <a href={localizedHref('/catalog', locale)}>{dict.common.goToCatalog}</a>{' '}
              <a href={localizedHref('/', locale)}>{dict.common.home}</a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
