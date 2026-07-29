/**
 * Микроразметка хлебных крошек — schema.org BreadcrumbList в формате JSON-LD.
 *
 * ЗАЧЕМ. Google рисует в выдаче путь «Магазин › О нас» вместо голого URL — это
 * заметный CTR-выигрыш для контентных страниц (доставка/оплата/оферта), которые
 * иначе выглядят одинаково. Разметка отдельная от `Metadata`: это `<script>` в
 * теле страницы, поэтому canonical/hreflang она не трогает.
 *
 * 🔴 ТОЛЬКО АБСОЛЮТНЫЕ URL. Спецификация требует `item` абсолютным; относительный
 * путь валидатор Google не принимает и разметка молча выпадает. База — та же
 * `seo.siteUrl` из настроек магазина, что и у hreflang (`absoluteUrlBase`). Нет
 * настройки → возвращаем null и НЕ выпускаем разметку вовсе: лучше её отсутствие,
 * чем битая. Домен нигде не зашит (мультитенантность).
 *
 * Чистая функция без React — тестируется юнитом.
 */

import { localizedHref, type Locale } from './i18n';

/**
 * Крошка — та же форма, что у визуального компонента `<Breadcrumbs>`: подпись
 * и необязательный бесхитростный путь (локаль навешивается при рендере).
 *
 * Тип объявлен ЗДЕСЬ, а не импортируется из компонента, намеренно: этот модуль
 * чистый (без React) и должен собираться корневым tsc, который каталог
 * `storefront/` не видит — импорт из `app/[lang]/components/*` втянул бы витрину
 * в чужой проект типов и посыпался бы на алиасе `@/`.
 */
export interface Crumb {
  label: string;
  href?: string;
}

/** Позиция списка. `item` отсутствует у последней (текущей) крошки — так советует Google. */
export interface BreadcrumbListItem {
  '@type': 'ListItem';
  position: number;
  name: string;
  item?: string;
}

export interface BreadcrumbJsonLd {
  '@context': 'https://schema.org';
  '@type': 'BreadcrumbList';
  itemListElement: BreadcrumbListItem[];
}

export interface BreadcrumbJsonLdOptions {
  locale: Locale;
  /** Подпись первой позиции («Главная») — из словаря витрины. */
  homeLabel: string;
  /** Абсолютная база магазина (absoluteUrlBase(settings)); null → разметки нет. */
  base: string | null;
}

/**
 * Крошки компонента `<Breadcrumbs>` → объект BreadcrumbList.
 *
 * @param items Те же крошки, что уходят в визуальный компонент (БЕЗ «Главной» —
 *              её компонент добавляет сам, и здесь она добавляется так же).
 * @returns null, если разметку выпускать нельзя (нет базы) или незачем (нет крошек).
 */
export function buildBreadcrumbJsonLd(
  items: readonly Crumb[],
  { locale, homeLabel, base }: BreadcrumbJsonLdOptions,
): BreadcrumbJsonLd | null {
  if (!base) return null;
  if (items.length === 0) return null;

  const abs = (path: string): string => `${base}${localizedHref(path, locale)}`;

  const itemListElement: BreadcrumbListItem[] = [
    { '@type': 'ListItem', position: 1, name: homeLabel, item: abs('/') },
  ];

  items.forEach((crumb, i) => {
    const position = i + 2;
    const last = i === items.length - 1;
    // Последняя позиция — текущая страница: `item` намеренно опущен (иначе
    // разметка ссылается сама на себя). Промежуточные — только если есть href.
    itemListElement.push(
      !last && crumb.href
        ? { '@type': 'ListItem', position, name: crumb.label, item: abs(crumb.href) }
        : { '@type': 'ListItem', position, name: crumb.label },
    );
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement,
  };
}
