/**
 * Middleware локализации витрины carre. Схема URL (как на старом carrerusse.com):
 *   - русский (ru, ОСНОВНОЙ) — КОРЕНЬ без префикса: `/`, `/catalog`, `/product/x`;
 *   - английский (en) — `/en`, `/en/catalog`, …;
 *   - французский (fr) — `/fr`, `/fr/catalog`, …
 *
 * Реализация: все страницы физически лежат под `app/[lang]/`. Здесь мы
 * ПЕРЕПИСЫВАЕМ (rewrite, не redirect — URL в адресной строке не меняется) голые
 * пути ru во внутренний `/ru/<path>`, чтобы сегмент [lang] всегда был заполнен.
 * Пути, начинающиеся с РЕАЛЬНОЙ не-дефолтной локали (`/en`, `/fr`), проходят как
 * есть. Явный `/ru/...` канонизируется постоянным редиректом на голый путь.
 *
 * 🔴 АУДИТ №33 + №12. Само решение вынесено в чистую `routeDecision` (lib/i18n) —
 * там же и подробный разбор дефекта: прежний regex «похоже на локаль» пропускал
 * ЛЮБОЙ двухбуквенный сегмент, из-за чего `/de/catalog` давал голую 404 Next без
 * шапки/футера, `/ru/...` — её же, а CMS-страница со slug `/qa` становилась
 * недостижимой (уезжала в маршрут `[lang]` вместо `[lang]/[slug]`).
 *
 * БД здесь по-прежнему НЕ читается: `routeDecision` опирается только на whitelist
 * языков, которые витрина физически умеет (компилятивная константа LOCALES), а
 * набор ВКЛЮЧЁННЫХ владельцем языков (он живёт в БД) проверяет layout.
 *
 * Статику/ассеты/служебные пути НЕ трогаем (matcher их исключает).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { routeDecision } from '@/lib/i18n';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Пробрасываем исходный путь в layout заголовком: серверный layout не получает
  // pathname из params, а он нужен, чтобы увести выключенный язык редиректом на
  // ТОТ ЖЕ путь дефолтной локали. Заголовок запроса, не ответа — наружу не течёт.
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);

  const decision = routeDecision(pathname);

  if (decision.kind === 'pass') {
    return NextResponse.next({ request: { headers } });
  }

  if (decision.kind === 'redirect') {
    const url = req.nextUrl.clone();
    url.pathname = decision.pathname;
    // 308 — постоянный редирект С СОХРАНЕНИЕМ метода и тела (в отличие от 301).
    return NextResponse.redirect(url, 308);
  }

  // rewrite: URL в браузере остаётся голым, query-строка сохраняется (clone).
  const url = req.nextUrl.clone();
  url.pathname = decision.pathname;
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
