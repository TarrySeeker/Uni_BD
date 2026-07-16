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
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n';

/** Префиксы локалей с видимым сегментом (все, кроме дефолтной ru). */
const PREFIXED_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Уже локализованный путь (/en, /en/..., /fr, /fr/...) — пропускаем как есть:
  // сегмент [lang] заполнит сам роутинг App Router.
  const hasLocalePrefix = PREFIXED_LOCALES.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`),
  );
  if (hasLocalePrefix) {
    return NextResponse.next();
  }

  // Голый путь = русская локаль. Переписываем во внутренний /ru/<path>,
  // сохраняя query-строку. URL в браузере остаётся голым (rewrite, не redirect).
  const url = req.nextUrl.clone();
  url.pathname =
    pathname === '/' ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${pathname}`;
  return NextResponse.rewrite(url);
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
