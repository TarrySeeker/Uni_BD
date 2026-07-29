/**
 * Боковое меню разделов дополнительных CMS-страниц (эталон carrerusse.com —
 * `.about__nav` в левой колонке, docs/41 §3).
 *
 * ⚠️ СОЗНАТЕЛЬНОЕ ОТЛИЧИЕ ОТ ЭТАЛОНА. На боевом carrerusse.com «Доставка»,
 * «Оплата», «FAQ», «Оферта» — не страницы, а ЯКОРИ внутри одной `/about`
 * (`data-scroll-to="#section-X"` + плавный скролл на jQuery). У нас каждая из них —
 * отдельная CMS-страница со своим URL, своим SEO-мета и своим переводом,
 * редактируемая в админке. Поэтому боковик стал НАВИГАЦИЕЙ ПО СТРАНИЦАМ: внешне
 * тот же вертикальный список слева, по сути — правильнее (индексируется,
 * переводится, шарится ссылкой).
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ — главное требование этого файла. Список пунктов НЕ зашит
 * в код: страница попадает в боковик тогда и только тогда, когда владелец отметил
 * её флагом «показывать в боковом меню» в карточке страницы (cms_pages.show_in_nav,
 * миграция 0060), а порядок задаёт nav_order. Магазин с двумя страницами и без
 * отметок получает пустой массив — витрина тогда не рисует левую колонку вовсе.
 *
 * Чистая функция без React/сети — тестируется юнитом (tests/storefront-ui/
 * cms-page-nav.test.ts).
 */

/** Строка списка страниц, как её отдаёт Storefront API `/pages`. */
export interface PageNavSource {
  slug: string;
  /** Подпись пункта = ЗАГОЛОВОК страницы, уже локализованный сервером. */
  title: string;
  showInNav?: boolean;
  navOrder?: number | null;
}

/** Готовый пункт бокового меню для рендера. */
export interface PageNavItem {
  slug: string;
  label: string;
  /** Бесхитростный путь `/<slug>`; префикс локали навешивает компонент. */
  href: string;
  /** Текущая страница — подсвечивается и не ведёт «сама на себя» вслепую. */
  current: boolean;
}

/**
 * Строит пункты бокового меню из списка опубликованных CMS-страниц.
 *
 * @param pages       Ответ `/pages` (уже локализованный сервером).
 * @param currentSlug Slug открытой страницы — для подсветки активного пункта.
 */
export function buildPageNav(
  pages: readonly PageNavSource[],
  currentSlug: string,
): PageNavItem[] {
  return pages
    // Только отмеченные владельцем. `=== true`, а не truthy: старый Admik без
    // миграции 0060 поля не пришлёт (undefined) — тогда боковик пуст, но
    // страница обязана отрендериться, а не упасть.
    .filter((p) => p.showInNav === true)
    .slice()
    .sort((a, b) => {
      const ao = a.navOrder;
      const bo = b.navOrder;
      // null/undefined = «порядок не задан» → в конец. Ноль и отрицательные —
      // валидные позиции, поэтому проверяем именно на null/undefined.
      const aSet = ao !== null && ao !== undefined;
      const bSet = bo !== null && bo !== undefined;
      if (aSet && bSet && ao !== bo) return ao - bo;
      if (aSet !== bSet) return aSet ? -1 : 1;
      // Равный (или отсутствующий) порядок → по заголовку, чтобы список не
      // «прыгал» между рендерами. localeCompare — человеческий порядок для
      // кириллицы/латиницы/диакритики.
      return a.title.localeCompare(b.title);
    })
    .map((p) => ({
      slug: p.slug,
      label: p.title,
      // encodeURIComponent: slug приходит из БД магазина; даже при валидной
      // slug-схеме на записи путь собираем безопасно (пробел/&/# не должны
      // рвать ссылку) — то же правило, что у getPage в lib/api.
      href: `/${encodeURIComponent(p.slug)}`,
      current: p.slug === currentSlug,
    }));
}
