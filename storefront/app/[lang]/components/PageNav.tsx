/**
 * Вертикальное меню разделов в левой колонке дополнительных страниц — порт
 * `.about__nav` эталона carrerusse.com (docs/41 §3): `.about__nav-item` /
 * `.about__nav-link`, классы сохранены 1:1, чтобы работали стили `/dist/app.css`.
 *
 * ⚠️ ОТЛИЧИЕ ОТ ЭТАЛОНА (осознанное). На проде пункты были ЯКОРЯМИ по одной
 * странице `/about` (`href="#"` + `data-scroll-to` + jQuery-скролл). Здесь это
 * НАСТОЯЩИЕ ССЫЛКИ на соседние CMS-страницы — каждая со своим URL, SEO и
 * переводом. Поэтому:
 *   • `js-scroll-top` / `data-scroll-to` не нужны — навигация работает без JS;
 *   • у активного пункта — модификатор `--current` и `aria-current="page"`
 *     (эталон подсветки не имел вовсе, у него все пункты были на одной странице).
 *
 * 🔴 Ни одной подписи и ни одного адреса в этом файле нет: пункты приходят
 * готовыми из buildPageNav (lib/cms-nav), собранными по данным магазина.
 * Компонент серверный (без состояния) — липкость боковика решена CSS `position:
 * sticky`, а не JS-хуком `js-about-us-sticky`, как на эталоне.
 */

import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import type { PageNavItem } from '@/lib/cms-nav';

export default function PageNav({
  items,
  locale = DEFAULT_LOCALE,
  title,
}: {
  items: readonly PageNavItem[];
  locale?: Locale;
  /** Доступная подпись меню («Разделы») — из словаря витрины, не литерал. */
  title: string;
}) {
  if (items.length === 0) return null;

  return (
    <nav className="about__nav" aria-label={title}>
      {items.map((item) => (
        <div className="about__nav-item" key={item.slug}>
          <a
            className={
              item.current ? 'about__nav-link about__nav-link--current' : 'about__nav-link'
            }
            href={localizedHref(item.href, locale)}
            aria-current={item.current ? 'page' : undefined}
          >
            {item.label}
          </a>
        </div>
      ))}
    </nav>
  );
}
