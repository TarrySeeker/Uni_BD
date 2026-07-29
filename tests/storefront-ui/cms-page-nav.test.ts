import { describe, expect, it } from 'vitest';

import {
  buildPageNav,
  type PageNavSource,
} from '../../storefront/lib/cms-nav';

/**
 * Боковое меню дополнительных CMS-страниц (эталон carrerusse.com `.about__nav`).
 *
 * ⚠️ Отличие от эталона — СОЗНАТЕЛЬНОЕ. На боевом carrerusse.com «Доставка»,
 * «Оплата», «FAQ», «Оферта» — это ЯКОРИ внутри одной страницы `/about`
 * (`data-scroll-to="#section-X"`). У нас каждая из них — отдельная CMS-страница со
 * своим URL/SEO/переводом, редактируемая в админке. Поэтому боковик — навигация
 * ПО СТРАНИЦАМ, а не скролл по якорям: выглядит как эталон, но каждый пункт
 * индексируется и переводится сам по себе.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. Набор пунктов НЕ зашит в код: страница попадает в боковик
 * тогда и только тогда, когда владелец поставил ей флаг «показывать в боковом
 * меню» (cms_pages.show_in_nav), а порядок задаёт nav_order. Магазин, который
 * флаг никому не поставил, получает пустой боковик — и страница рендерится на
 * всю ширину, без пустой колонки.
 */

/** Фабрика строки списка страниц (форма PublicPageListItemDto витрины). */
function page(over: Partial<PageNavSource> & { slug: string }): PageNavSource {
  return {
    title: over.slug,
    showInNav: true,
    navOrder: null,
    ...over,
  };
}

describe('buildPageNav — источник пунктов бокового меню', () => {
  it('берёт ТОЛЬКО страницы с showInNav=true (флаг владельца, не хардкод)', () => {
    const nav = buildPageNav(
      [
        page({ slug: 'about', title: 'О нас', navOrder: 1 }),
        page({ slug: 'secret', title: 'Черновик-лендинг', showInNav: false, navOrder: 2 }),
        page({ slug: 'delivery', title: 'Доставка', navOrder: 3 }),
      ],
      'about',
    );

    expect(nav.map((i) => i.slug)).toEqual(['about', 'delivery']);
  });

  it('магазин без единого отмеченного пункта → пустой боковик (мультитенант)', () => {
    const nav = buildPageNav(
      [
        page({ slug: 'about', showInNav: false }),
        page({ slug: 'policy', showInNav: false }),
      ],
      'about',
    );
    expect(nav).toEqual([]);
  });

  it('сортирует по navOrder; страницы без порядка — в конец, между собой по title', () => {
    const nav = buildPageNav(
      [
        page({ slug: 'faq', title: 'Частые вопросы', navOrder: null }),
        page({ slug: 'pay', title: 'Оплата', navOrder: 20 }),
        page({ slug: 'about', title: 'О нас', navOrder: 10 }),
        page({ slug: 'contacts', title: 'Контакты', navOrder: null }),
      ],
      'about',
    );

    // Сначала — заданный порядок (10, 20), затем безпорядковые по алфавиту
    // заголовка: «Контакты» < «Частые вопросы».
    expect(nav.map((i) => i.slug)).toEqual(['about', 'pay', 'contacts', 'faq']);
  });

  it('отрицательный и нулевой navOrder — валидные позиции (0 не равен «не задан»)', () => {
    const nav = buildPageNav(
      [
        page({ slug: 'b', navOrder: 0 }),
        page({ slug: 'a', navOrder: -5 }),
        page({ slug: 'c', navOrder: null }),
      ],
      'a',
    );
    expect(nav.map((i) => i.slug)).toEqual(['a', 'b', 'c']);
  });

  it('подсвечивает ТЕКУЩУЮ страницу (current=true ровно у одной)', () => {
    const nav = buildPageNav(
      [page({ slug: 'about' }), page({ slug: 'delivery' })],
      'delivery',
    );
    expect(nav.filter((i) => i.current).map((i) => i.slug)).toEqual(['delivery']);
  });

  it('текущая страница вне боковика (showInNav=false) → ни один пункт не подсвечен', () => {
    const nav = buildPageNav(
      [page({ slug: 'about' }), page({ slug: 'promo', showInNav: false })],
      'promo',
    );
    expect(nav.some((i) => i.current)).toBe(false);
    expect(nav.map((i) => i.slug)).toEqual(['about']);
  });

  it('href — бесхитростный путь /<slug>; локаль навешивает компонент (localizedHref)', () => {
    const nav = buildPageNav([page({ slug: 'delivery' })], 'about');
    expect(nav[0]!.href).toBe('/delivery');
  });

  it('slug со спецсимволами кодируется в href (анти-инъекция пути)', () => {
    const nav = buildPageNav([page({ slug: 'a b&c' })], 'about');
    expect(nav[0]!.href).toBe('/a%20b%26c');
  });

  it('пустой список страниц (API недоступен) → пустой боковик, без падения', () => {
    expect(buildPageNav([], 'about')).toEqual([]);
  });

  it('устойчив к старому API без полей showInNav/navOrder (undefined ≠ показывать)', () => {
    // Витрина может временно работать со старым Admik: поля ещё нет в ответе.
    // Тогда боковик пуст — но страница обязана отрендериться, а не упасть.
    const legacy = [{ slug: 'about', title: 'О нас' }] as unknown as PageNavSource[];
    expect(buildPageNav(legacy, 'about')).toEqual([]);
  });
});
