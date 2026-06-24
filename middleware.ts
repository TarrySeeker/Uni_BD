import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '@/lib/auth/constants';

/**
 * Быстрый барьер доступа к /admin/* (docs/04 §5.3, задача 1.4).
 *
 * Middleware — лишь БЫСТРАЯ проверка НАЛИЧИЯ cookie сессии (без обращения к БД,
 * т.к. middleware работает в edge-окружении без драйвера postgres). Полную
 * валидацию сессии (срок, статус пользователя, права) делает серверный layout
 * через requireUser() (§6.2). Так мы дёшево отсекаем заведомо неавторизованных
 * до рендера, а настоящее решение о доступе остаётся на сервере (двойная защита).
 *
 * Исключение: /admin/login доступен без сессии (иначе нельзя войти).
 */

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Страница логина — единственный публичный путь под /admin.
  if (pathname === '/admin/login') {
    return NextResponse.next();
  }

  const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionId) {
    const loginUrl = new URL('/admin/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  const res = NextResponse.next();

  // m8: переустанавливаем cookie со СВЕЖИМ сроком (скользящее окно). Серверная
  // validateSession продлевает сессию в БД (now()+TTL), но cookie иначе хранил бы
  // login-time-срок → браузер «разлогинивал» бы при активной сессии. Только на GET
  // (навигации): на POST/server-action НЕ трогаем, чтобы не перебить очистку cookie
  // при логауте (его Set-Cookie maxAge=0 идёт в ответе того же запроса).
  if (request.method === 'GET') {
    res.cookies.set(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  }

  return res;
}

/**
 * Применяем middleware ко всем путям /admin/* (включая корень /admin).
 * Статика и API сюда не попадают.
 */
export const config = {
  matcher: ['/admin/:path*'],
};
