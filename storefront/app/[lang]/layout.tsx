/**
 * Корневой layout витрины carre (под сегментом локали `[lang]`). Тянет
 * брендинг/навигацию из Storefront API УЖЕ ЛОКАЛИЗОВАННО (`?locale=`) и оборачивает
 * контент в шапку+меню+футер (дизайн 1:1 из frontend/views/layouts/main.twig).
 * Дизайн — скопированный собранный CSS carre (/dist/app.css) + storefront.css.
 *
 * i18n: `lang` берётся из route-параметра (middleware гарантирует ru|en|fr).
 * `<html lang>` = текущая локаль (не хардкод). Локаль пробрасывается в шапку/футер
 * (переключатель языка + локализованные ссылки) и во все вызовы API.
 *
 * generateStaticParams перечисляет три локали — сегмент можно пререндерить, но
 * страницы всё равно force-dynamic (API поднят только в рантайме).
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getCategories, getSettings } from '@/lib/api';
import { rootCategories, topLevelCategories } from '@/lib/tree';
import { CurrencyProvider } from '@/lib/currency';
import { HTML_LANG, LOCALES, toLocale } from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';

export const metadata: Metadata = {
  title: 'carre — шёлковые платки и аксессуары',
  description: 'Интернет-магазин шёлковых платков, твилли и аксессуаров.',
  icons: {
    icon: [
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

/** Пререндер сегмента локали для всех трёх языков. */
export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export default async function RootLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const locale = toLocale(lang);
  const dict = getDictionary(locale);

  const [settings, categories] = await Promise.all([
    getSettings(locale),
    getCategories(locale),
  ]);
  // Меню шапки — оба корня со всей вложенностью; футер — группы каталога.
  const menuRoots = rootCategories(categories);
  const footerCats = topLevelCategories(categories);

  return (
    <html lang={HTML_LANG[locale]}>
      <body className="page--main">
        {/* Собранный дизайн carre + дополняющие стили витрины (React 19 hoist в <head>). */}
        <link rel="stylesheet" href="/dist/app.css" precedence="default" />
        <link rel="stylesheet" href="/storefront.css" precedence="default" />

        {/* CurrencyProvider — выбор валюты отображения (₽/€) на весь клиент витрины. */}
        <CurrencyProvider settings={settings}>
          <SiteHeader
            categories={menuRoots}
            settings={settings}
            locale={locale}
            dict={dict}
          />

          <div className="main-content main-content--pt main-content--pb">{children}</div>

          <SiteFooter
            categories={footerCats}
            settings={settings}
            locale={locale}
            dict={dict}
          />
        </CurrencyProvider>
      </body>
    </html>
  );
}
