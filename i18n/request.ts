import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

import {
  ADMIN_LOCALE_COOKIE,
  resolveAdminLocale,
} from '@/lib/i18n/admin-locale';

/**
 * Request-конфиг next-intl для ИНТЕРФЕЙСА админки (next-intl foundation, STEP C).
 *
 * Без i18n-роутинга: админка остаётся на /admin, язык интерфейса берётся из cookie
 * NEXT_LOCALE (предпочтение оператора), а не из сегмента URL. Поэтому конфиг ОБЯЗАН
 * вернуть явный `locale` — requestLocale/роутинга здесь нет.
 *
 * cookies() в Next 16 асинхронна — ждём её. resolveAdminLocale не доверяет сырому
 * значению (валидация в набор ['ru','en','fr'], фолбэк на 'ru').
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get(ADMIN_LOCALE_COOKIE)?.value;
  const locale = resolveAdminLocale(cookieValue);

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
