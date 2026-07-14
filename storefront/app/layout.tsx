/**
 * Корневой layout витрины carre. Тянет брендинг/навигацию из Storefront API и
 * оборачивает контент в шапку+меню+футер (дизайн 1:1 из frontend/views/layouts/
 * main.twig). Дизайн подключается скопированным собранным CSS carre
 * (/dist/app.css) + небольшим дополняющим storefront.css.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getCategories, getSettings } from '@/lib/api';
import { rootCategories, topLevelCategories } from '@/lib/tree';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [settings, categories] = await Promise.all([getSettings(), getCategories()]);
  // Меню шапки — оба корня со всей вложенностью; футер — группы каталога.
  const menuRoots = rootCategories(categories);
  const footerCats = topLevelCategories(categories);

  return (
    <html lang="ru">
      <body className="page--main">
        {/* Собранный дизайн carre + дополняющие стили витрины (React 19 hoist в <head>). */}
        <link rel="stylesheet" href="/dist/app.css" precedence="default" />
        <link rel="stylesheet" href="/storefront.css" precedence="default" />

        <SiteHeader categories={menuRoots} settings={settings} />

        <div className="main-content main-content--pt main-content--pb">{children}</div>

        <SiteFooter categories={footerCats} settings={settings} />
      </body>
    </html>
  );
}
