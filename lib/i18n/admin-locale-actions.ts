'use server';

import { cookies } from 'next/headers';

import { sql } from '@/lib/db/client';
import { requireUser } from '@/lib/auth/session';
import {
  ADMIN_LOCALE_COOKIE,
  resolveAdminLocale,
} from '@/lib/i18n/admin-locale';

/**
 * Server Action смены языка ИНТЕРФЕЙСА админки (next-intl foundation, STEP H).
 *
 * Живёт в отдельном 'use server'-модуле, а НЕ в admin-locale.ts: тот обязан
 * оставаться client-safe (ноль БД/server-only), т.к. его импортирует клиентский
 * код. Здесь же требуются requireUser (БД) и cookies() (server-only) — граница
 * 'use server' держит эту цепочку вне браузерного бандла.
 *
 * Механизм (без UI на этом шаге): валидируем присланный язык, сохраняем
 * предпочтение оператора в users.ui_locale (миграция 0057) и ставим cookie
 * NEXT_LOCALE, который читает i18n/request.ts на следующем запросе. К кнопке
 * пока не подключён — переключатель добавляется отдельным шагом.
 *
 * Год жизни cookie: предпочтение языка долгоживущее; при отсутствии cookie
 * request.ts всё равно откатывается на defaultLocale ('ru').
 */
const ADMIN_LOCALE_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

export async function setAdminUiLocale(locale: string): Promise<void> {
  // Только аутентифицированный оператор меняет свой язык (нет сессии → redirect).
  const user = await requireUser();

  // НИКОГДА не доверяем присланному значению: нормализуем/валидируем в набор.
  const resolved = resolveAdminLocale(locale);

  await sql`UPDATE users SET ui_locale = ${resolved} WHERE id = ${user.id}`;

  const store = await cookies();
  store.set(ADMIN_LOCALE_COOKIE, resolved, {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ADMIN_LOCALE_COOKIE_MAX_AGE_SEC,
  });
}
