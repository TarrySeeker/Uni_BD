import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { getLocale, getTranslations } from 'next-intl/server';

import './globals.css';

/**
 * Корневые метаданные — ТОЛЬКО через generateMetadata().
 *
 * WHY: статический `export const metadata` вычисляется вне запроса, поэтому язык
 * оператора (cookie NEXT_LOCALE → i18n/request.ts) до него физически не доходит —
 * <title> оставался русским даже при NEXT_LOCALE=en/fr, хотя сам интерфейс
 * переводился. getTranslations() — серверный, читает тот же request-конфиг, что и
 * остальная админка.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();

  return {
    title: t('common.app.title'),
    description: t('common.app.description'),
  };
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // lang обязан следовать языку интерфейса: по нему работают скринридеры и переносы
  // слов, а раньше он был забит как "ru" даже при английской панели.
  const locale = await getLocale();

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
