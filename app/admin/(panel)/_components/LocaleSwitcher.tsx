'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { ADMIN_LOCALE_CONFIG } from '@/lib/i18n/admin-locale';
import { setAdminUiLocale } from '@/lib/i18n/admin-locale-actions';

/**
 * Переключатель ЯЗЫКА ИНТЕРФЕЙСА админки (next-intl foundation).
 *
 * Клиентский лист: маленький доступный <select> с платформенным набором языков
 * интерфейса (ADMIN_LOCALE_CONFIG.locales — ['ru','en','fr']). Опции подписаны
 * НАТИВНЫМИ именами языков (common.languages.*), которые одинаковы во всех
 * каталогах — переключатель показывает «Русский / English / Français» независимо
 * от текущей локали интерфейса.
 *
 * Текущий язык приходит пропом `current` (его читает серверный Topbar через
 * getLocale()), поэтому компонент не обращается к cookie/сессии сам. При выборе
 * вызываем Server Action setAdminUiLocale (пишет users.ui_locale + cookie
 * NEXT_LOCALE) внутри useTransition, затем router.refresh() — layout и request-
 * конфиг перечитываются на сервере и панель мгновенно перерисовывается на новом
 * языке (без i18n-роутинга, URL /admin остаётся прежним).
 */
export function LocaleSwitcher({ current }: { current: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (next === current) return;
    startTransition(async () => {
      await setAdminUiLocale(next);
      router.refresh();
    });
  }

  return (
    <select
      data-testid="admin-locale-switcher"
      aria-label={t('layout.localeSwitcher.label')}
      value={current}
      disabled={pending}
      onChange={onChange}
      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60"
    >
      {ADMIN_LOCALE_CONFIG.locales.map((loc) => (
        <option key={loc} value={loc}>
          {t(`common.languages.${loc}`)}
        </option>
      ))}
    </select>
  );
}
