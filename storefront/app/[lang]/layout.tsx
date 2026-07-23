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
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCategories, getSettings } from '@/lib/api';
import { rootCategories, topLevelCategories } from '@/lib/tree';
import { siteTitle } from '@/lib/seo';
import { CurrencyProvider } from '@/lib/currency';
import {
  HTML_LANG,
  DEFAULT_LOCALE,
  toLocale,
  enabledLocalesFrom,
  switchLocalePath,
} from '@/lib/i18n';
import { getDictionary } from '@/lib/dictionaries';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';

/**
 * Заголовок/описание — из админки (settings.seo), как на проде (thread.seo_title).
 * `title.template` применяется к дочерним страницам, задающим свой title; `default`
 * — фолбэк для страниц без него.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const settings = await getSettings(locale);
  const name = siteTitle(settings);
  const template = settings?.seo.titleTemplate ?? '%s';

  return {
    title: {
      default: name,
      template: template.includes('%s') ? template : '%s',
    },
    description: settings?.seo.defaultDescription ?? undefined,
    icons: {
      icon: [
        { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
        { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      ],
      apple: '/apple-touch-icon.png',
    },
  };
}

/**
 * Пререндерим только дефолтную локаль: набор ВКЛЮЧЁННЫХ языков известен лишь в
 * рантайме (из настроек магазина, force-dynamic за запрос), а нефиксированный
 * список менять на этапе сборки нельзя. en/fr рендерятся динамически (dynamicParams).
 */
export function generateStaticParams() {
  return [{ lang: DEFAULT_LOCALE }];
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

  // Связка с настройкой языков (волна 5): enabled-набор = включённые в админке
  // языки ∩ whitelist витрины. Если запрошенный язык выключен (нет в наборе) и это
  // НЕ дефолт — уводим ВРЕМЕННЫМ редиректом на тот же путь дефолтной локали.
  // 🔴 Именно временный 307 (redirect), а НЕ постоянный 301: 301 закрепил бы
  // /en→/ в кэшах навсегда, а язык могут снова включить. Дефолт не редиректится
  // (он всегда в наборе). Настройки недоступны → enabledLocalesFrom fail-open
  // вернёт весь whitelist → редиректа нет (включение работает лишь по реальному
  // набору из админки).
  const enabledLocales = enabledLocalesFrom(settings?.i18n?.locales);
  if (locale !== DEFAULT_LOCALE && !enabledLocales.includes(locale)) {
    const pathname = (await headers()).get('x-pathname') ?? `/${locale}`;
    redirect(switchLocalePath(pathname, DEFAULT_LOCALE));
  }

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
            enabledLocales={enabledLocales}
            dict={dict}
          />

          <div className="main-content main-content--pt main-content--pb">{children}</div>

          <SiteFooter
            categories={footerCats}
            tree={menuRoots}
            settings={settings}
            locale={locale}
            dict={dict}
          />
        </CurrencyProvider>
      </body>
    </html>
  );
}
