/**
 * Хлебные крошки — порт frontend/views/misc_blocks/_breadcrumbs.twig (классы
 * .breadcrumbs / .breadcrumbs__colon / .breadcrumbs-mh* сохранены 1:1).
 * i18n: подпись «Главная» из словаря; href элементов (бесхитростные `/…` пути)
 * локализуются через localizedHref — вызывающим страницам локаль знать не нужно.
 */

import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

export interface Crumb {
  label: string;
  /** Бесхитростный путь (`/catalog`, `/catalog/twilly`) — локаль навесит компонент. */
  href?: string;
}

export default function Breadcrumbs({
  items,
  locale = DEFAULT_LOCALE,
  homeLabel = 'Главная',
}: {
  items: Crumb[];
  locale?: Locale;
  homeLabel?: string;
}) {
  return (
    <div className="breadcrumbs">
      <a
        href={localizedHref('/', locale)}
        className={items.length > 1 ? 'breadcrumbs-mh' : undefined}
      >
        {homeLabel}
      </a>
      {items.map((bc, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${bc.label}-${i}`}>
            <span className="breadcrumbs__colon breadcrumbs-mh">›</span>
            {bc.href && !last ? (
              <a href={localizedHref(bc.href, locale)} className="breadcrumbs-mha">
                {bc.label}
              </a>
            ) : (
              <span className="breadcrumbs-mha">{bc.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
