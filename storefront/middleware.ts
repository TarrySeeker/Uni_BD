/**
 * Middleware локализации витрины carre. Схема URL (как на старом carrerusse.com):
 *   - русский (ru, ОСНОВНОЙ) — КОРЕНЬ без префикса: `/`, `/catalog`, `/product/x`;
 *   - английский (en) — `/en`, `/en/catalog`, …;
 *   - французский (fr) — `/fr`, `/fr/catalog`, …
 *
 * Реализация: все страницы физически лежат под `app/[lang]/`. Здесь мы
 * ПЕРЕПИСЫВАЕМ (rewrite, не redirect — URL в адресной строке не меняется) голые
 * пути ru во внутренний `/ru/<path>`, чтобы сегмент [lang] всегда был заполнен.
 * Пути, уже начинающиеся с `/en` или `/fr`, проходят без изменений. Голый `/en`
 * (без хвостового слэша) и `/fr` тоже валидны — matcher их пропускает как есть.
 *
 * Статику/ассеты/служебные пути НЕ трогаем (matcher их исключает).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE } from '@/lib/i18n';

/**
 * Сегмент, ПОХОЖИЙ на префикс локали: двухбуквенный ISO-код с опциональным
 * регионом (ru, en, pt-br). 🔴 middleware работает на edge и БД НЕ ЧИТАЕТ — какой
 * язык реально включён/валиден, решает layout (там доступны настройки магазина).
 * Здесь лишь распознаём форму префикса: похоже на локаль → пропускаем сегмент как
 * есть, остальное — rewrite в дефолтную локаль. Так набор языков не зашит в edge
 * (нет задержки/точки отказа/риска утечки конфига), а включение нового языка не
 * требует правки middleware.
 */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/;

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Пробрасываем исходный путь в layout заголовком: серверный layout не получает
  // pathname из params, а он нужен, чтобы увести выключенный язык редиректом на
  // ТОТ ЖЕ путь дефолтной локали. Заголовок запроса, не ответа — наружу не течёт.
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);

  const first = pathname.split('/').filter(Boolean)[0];

  // Похожий на локаль префикс (кроме дефолтной ru, живущей на корне) — пропускаем
  // как есть: сегмент [lang] заполнит роутинг, а валидность/включённость проверит
  // layout (неизвестный/выключенный язык он уведёт редиректом на дефолт).
  if (first && first !== DEFAULT_LOCALE && LOCALE_SEGMENT.test(first)) {
    return NextResponse.next({ request: { headers } });
  }

  // Голый путь = дефолтная локаль. Переписываем во внутренний /<default>/<path>,
  // сохраняя query-строку. URL в браузере остаётся голым (rewrite, не redirect).
  const url = req.nextUrl.clone();
  url.pathname =
    pathname === '/' ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${pathname}`;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  /**
   * Пропускаем через middleware всё, КРОМЕ служебных/статических путей:
   *  - /api/*        — здесь витрина API не держит, но на всякий исключаем;
   *  - /_next/*      — бандлы/чанки/данные Next;
   *  - /dist/*, /images/*, /storefront.css и файлы с расширением (favicon и т.п.).
   * Так rewrite не ломает загрузку ассетов (иначе /dist/app.css → /ru/dist/app.css).
   */
  matcher: ['/((?!api|_next|dist|images|.*\\.[\\w]+$).*)'],
};
