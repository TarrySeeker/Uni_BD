import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMenuModel, menuHref } from '../../storefront/lib/menu';
import { menuSections } from '../../storefront/lib/tree';
import { getDictionary } from '../../storefront/lib/dictionaries';
import { LOCALES, type Locale } from '../../storefront/lib/i18n';
import type { CategoryDto, PublicSettingsDto } from '../../storefront/lib/types';

/**
 * ШАПКА + ВЫЕЗЖАЮЩЕЕ МЕНЮ = эталон carrerusse.com (docs/41 §2), но БЕЗ хардкода
 * под carre. Как и у подвала, два требования обязаны выполняться ОДНОВРЕМЕННО:
 *
 *  1) разметка/классы/порядок — как в слепке прода: `.page-menu` → `.page-menu-top`
 *     (`.menu-block` с `+`/`—` на каждый раздел каталога) → две группы
 *     `.page-menu-top-links` с разделительной линией → серый `.page-menu-footer`
 *     с `.mm-langs` и `.mm-cur`;
 *  2) СОДЕРЖИМОЕ — данные магазина: разделы из дерева категорий API, почты и
 *     телефон из settings.contacts / settings.legalEntity, служебные ссылки из
 *     settings.navigation.header. Ни «Твилли», ни support@carrerusse.com, ни
 *     +7 (905) 043-80-74 в коде быть не должно — это ОДИН магазин, а платформа
 *     обслуживает многие.
 *
 * Плюс класс дефекта version skew: настройки могут прийти без любой секции —
 * меню обязано это пережить и не рендерить пустых пунктов.
 */

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

const HEADER_TSX = 'app/[lang]/SiteHeader.tsx';
const MENU_TS = 'lib/menu.ts';

/** Дерево категорий магазина (нейтральное, НЕ carre): два корня, вложенность 2. */
const TREE: CategoryDto[] = [
  {
    id: '1',
    slug: 'bags',
    name: 'Сумки',
    children: [
      { id: '11', slug: 'bags-tote', name: 'Шопперы', children: [] },
      { id: '12', slug: 'bags-clutch', name: 'Клатчи', children: [] },
    ],
  },
  {
    id: '2',
    slug: 'shoes',
    name: 'Обувь',
    children: [{ id: '21', slug: 'shoes-boots', name: 'Ботинки', children: [] }],
  },
  { id: '3', slug: 'sale', name: 'Распродажа', children: [] },
] as unknown as CategoryDto[];

function settings(patch: Record<string, unknown> = {}): PublicSettingsDto {
  return patch as unknown as PublicSettingsDto;
}

function build(
  s: PublicSettingsDto | null,
  locale: Locale = 'ru',
  categories: CategoryDto[] = TREE,
) {
  return buildMenuModel({
    categories,
    tree: categories,
    settings: s,
    locale,
    dict: getDictionary(locale),
  });
}

// ---------------------------------------------------------------------------
// 1. Разметка = эталон
// ---------------------------------------------------------------------------

describe('разметка меню повторяет эталон carrerusse.com', () => {
  const code = src(HEADER_TSX);

  const REQUIRED_CLASSES = [
    'page-head',
    'burger',
    'page-head-logo',
    'page-head-settings',
    'page-head-icons',
    'page-menu',
    'page-menu-top',
    'page-menu-top-main',
    'menu-block',
    'menu-block-head',
    'menu-block-links',
    'page-menu-top-links',
    'page-menu-footer',
    'page-menu-footer-item',
    'mm-row',
    'mm-langs',
    'mm-cur',
  ];

  for (const cls of REQUIRED_CLASSES) {
    it(`есть класс .${cls}`, () => {
      expect(code).toContain(cls);
    });
  }

  it('раскрывающийся раздел несёт ОБА индикатора эталона: «+» и «—»', () => {
    expect(code).toContain('menu-block-head--plus');
    expect(code).toContain('menu-block-head--minus');
  });

  it('раскрытие идёт классом .open на .menu-block (CSS max-height), а не инлайн-стилем', () => {
    expect(code).toMatch(/menu-block\$\{[^}]*open/);
    expect(code).not.toMatch(/style=\{\{[^}]*maxHeight/);
  });

  it('классы меню реально существуют в CSS витрины (собранный дизайн + дополняющий)', () => {
    // Витрина подключает ОБА листа (layout: /dist/app.css + /storefront.css),
    // поэтому и проверяем их вместе: класс из любого — рабочий.
    const css =
      readFileSync(resolve(STOREFRONT, 'public/dist/app.css'), 'utf8') +
      readFileSync(resolve(STOREFRONT, 'public/storefront.css'), 'utf8');
    for (const cls of REQUIRED_CLASSES) {
      expect(css, `.${cls} отсутствует в CSS витрины`).toContain(`.${cls}`);
    }
    // Механика эталона: панель выезжает трансформом по классу на <body>.
    expect(css).toContain('.page-menu-open .page-menu');
    // Раскрытие подсписка — max-height по классу .open.
    expect(css).toContain('.menu-block.open .menu-block-links');
  });

  it('кнопки меню сброшены к виду эталона (браузерная окраска <button> снята)', () => {
    const css = readFileSync(resolve(STOREFRONT, 'public/storefront.css'), 'utf8');
    // Тег сменился на <button> ради доступности — вид меняться не должен.
    expect(css).toContain('.page-menu-top .menu-block-head');
    expect(css).toMatch(/appearance:\s*none/);
    // Клавиатурная навигация обязана быть ВИДНА.
    expect(css).toMatch(/:focus-visible/);
  });

  it('меню выезжает классом page-menu-open на <body> (как в эталонном app.js)', () => {
    expect(code).toContain('page-menu-open');
    expect(code).toContain('document.body.classList');
  });
});

// ---------------------------------------------------------------------------
// 2. Мультитенантность: ни одного литерала carre
// ---------------------------------------------------------------------------

describe('в шапке и меню нет содержимого конкретного магазина', () => {
  const files = [HEADER_TSX, MENU_TS];

  /** Проверяем ИСПОЛНЯЕМЫЙ код: документация по-русски и ссылки на docs/41 законны. */
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const FORBIDDEN = [
    /carre/i,
    /support@/i,
    /contact@/i,
    /905\s*043/,
    /\/catalog\/twilly/,
    /Твилли/i,
    /platki-i-sharfi/,
  ];

  for (const rel of files) {
    for (const pattern of FORBIDDEN) {
      it(`${rel} не содержит ${pattern} в коде`, () => {
        expect(stripComments(src(rel))).not.toMatch(pattern);
      });
    }
  }

  it('в JSX шапки нет русских литералов (все тексты — из словаря/настроек)', () => {
    const cyrillicStrings =
      stripComments(src(HEADER_TSX)).match(/(['"`])[^'"`\n]*[А-Яа-яЁё][^'"`\n]*\1/g) ?? [];
    expect(cyrillicStrings, `${HEADER_TSX}: русские литералы в коде`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Разделы каталога — развёрнуты, каждый со своим «+»
// ---------------------------------------------------------------------------

describe('пункты каталога в меню = разделы магазина, каждый раскрываемый', () => {
  it('каждый корневой раздел — отдельный пункт меню В ТОМ ЖЕ порядке, что в дереве', () => {
    const model = build(settings({}));
    expect(model.catalog.map((c) => c.label)).toEqual(['Сумки', 'Обувь', 'Распродажа']);
  });

  it('раздел С подразделами раскрываемый, БЕЗ подразделов — простая ссылка', () => {
    const model = build(settings({}));
    expect(model.catalog[0].expandable).toBe(true);
    expect(model.catalog[1].expandable).toBe(true);
    // «Распродажа» детей не имеет → никакого пустого «+».
    expect(model.catalog[2].expandable).toBe(false);
    expect(model.catalog[2].children).toEqual([]);
  });

  it('первым подпунктом раскрытого раздела идёт «Все» на сам раздел (как на эталоне)', () => {
    const model = build(settings({}));
    const bags = model.catalog[0];
    expect(bags.children[0].label).toBe(getDictionary('ru').common.all);
    expect(bags.children[0].href).toBe('/catalog/bags');
    expect(bags.children.slice(1).map((c) => c.label)).toEqual(['Шопперы', 'Клатчи']);
  });

  it('адреса подразделов — вложенные, как на проде (/catalog/родитель/ребёнок)', () => {
    const model = build(settings({}));
    expect(model.catalog[0].children[1].href).toBe('/catalog/bags/bags-tote');
    expect(model.catalog[0].href).toBe('/catalog/bags');
  });

  it('локаль применяется ко всем адресам каталога', () => {
    const model = build(settings({}), 'fr');
    expect(model.catalog[0].href).toBe('/fr/catalog/bags');
    expect(model.catalog[0].children[0].href).toBe('/fr/catalog/bags');
  });

  it('каталог пуст (магазин без категорий) → пунктов каталога нет, меню не падает', () => {
    const model = build(settings({}), 'ru', []);
    expect(model.catalog).toEqual([]);
    expect(model.serviceLinks.length + model.accountLinks.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 ГЛАВНЫЙ ДЕФЕКТ, ради которого писался этот файл. Дерево /categories приходит
   * с ТЕХНИЧЕСКИМ корнем `catalog`, который сам разделом не является. Пока меню
   * рендерило корни как есть, весь каталог прятался за одним пунктом «Каталог +»
   * — вместо списка разделов эталона, где у КАЖДОГО свой «+».
   */
  describe('технический корень `catalog` развёрнут в разделы (а не пункт «Каталог +»)', () => {
    const WRAPPED: CategoryDto[] = [
      {
        id: 'c',
        slug: 'catalog',
        name: 'Каталог',
        children: [
          {
            id: '1',
            slug: 'bags',
            name: 'Сумки',
            children: [{ id: '11', slug: 'bags-tote', name: 'Шопперы', children: [] }],
          },
          { id: '2', slug: 'shoes', name: 'Обувь', children: [] },
        ],
      },
      { id: 'g', slug: 'certificates', name: 'Сертификаты', children: [] },
    ] as unknown as CategoryDto[];

    it('menuSections разворачивает корень: разделы наверх, корень-лист остаётся собой', () => {
      expect(menuSections(WRAPPED).map((c) => c.slug)).toEqual([
        'bags',
        'shoes',
        'certificates',
      ]);
    });

    it('в меню НЕТ пункта-обёртки «Каталог»: каждый раздел — свой пункт со своим «+»', () => {
      const model = buildMenuModel({
        categories: menuSections(WRAPPED),
        tree: WRAPPED,
        settings: settings({}),
        locale: 'ru',
        dict: getDictionary('ru'),
      });
      expect(model.catalog.map((c) => c.label)).toEqual(['Сумки', 'Обувь', 'Сертификаты']);
      expect(model.catalog.map((c) => c.key)).not.toContain('catalog');
      expect(model.catalog[0].expandable).toBe(true);
    });

    it('адреса строятся по ПОЛНОМУ дереву: сегмент `catalog` в путь не дублируется', () => {
      const model = buildMenuModel({
        categories: menuSections(WRAPPED),
        tree: WRAPPED,
        settings: settings({}),
        locale: 'ru',
        dict: getDictionary('ru'),
      });
      expect(model.catalog[0].href).toBe('/catalog/bags');
      expect(model.catalog[0].children[1].href).toBe('/catalog/bags/bags-tote');
      expect(model.catalog[0].href).not.toContain('/catalog/catalog');
    });

    it('layout отдаёт в шапку РАЗДЕЛЫ и ОТДЕЛЬНО полное дерево (иначе пути схлопнутся)', () => {
      const layout = src('app/[lang]/layout.tsx');
      expect(layout).toContain('menuSections');
      expect(layout).toMatch(/<SiteHeader[\s\S]{0,400}tree=\{/);
    });
  });

  it('число разделов не зафиксировано в коде: 6 корней проходят как есть', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => ({
      id: s,
      slug: s,
      name: s.toUpperCase(),
      children: [],
    })) as unknown as CategoryDto[];
    expect(build(settings({}), 'ru', many).catalog).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 4. Служебные группы с разделителями
// ---------------------------------------------------------------------------

describe('две группы плоских ссылок под каталогом — как на эталоне', () => {
  it('группа «сервис» берётся из settings.navigation.header (порядок владельца)', () => {
    const model = build(
      settings({
        navigation: {
          header: [
            { label: 'Оптовикам', href: '/wholesale' },
            { label: 'Сертификаты', href: '/certificates' },
          ],
        },
      }),
    );
    expect(model.serviceLinks.map((l) => l.label)).toEqual(['Оптовикам', 'Сертификаты']);
    expect(model.serviceLinks.map((l) => l.href)).toEqual(['/wholesale', '/certificates']);
  });

  it('владелец служебных ссылок не задал → группы нет (пустых пунктов не рисуем)', () => {
    expect(build(settings({})).serviceLinks).toEqual([]);
    expect(build(settings({ navigation: { header: [] } })).serviceLinks).toEqual([]);
    expect(build(null).serviceLinks).toEqual([]);
  });

  it('битые служебные ссылки отбрасываются, а не рендерятся дырами', () => {
    const model = build(
      settings({
        navigation: {
          header: [
            { label: '', href: '/x' },
            { label: 'Ок', href: '' },
            { label: 'Живая', href: '/live' },
          ],
        },
      }),
    );
    expect(model.serviceLinks.map((l) => l.label)).toEqual(['Живая']);
  });

  it('внешние адреса служебных ссылок не ломаются локализацией', () => {
    const model = build(
      settings({
        navigation: {
          header: [
            { label: 'Внутр', href: '/corporate' },
            { label: 'Внешн', href: 'https://example.com/b2b' },
          ],
        },
      }),
      'en',
    );
    expect(model.serviceLinks[0].href).toBe('/en/corporate');
    expect(model.serviceLinks[1].href).toBe('https://example.com/b2b');
  });

  it('группа «Избранное / Корзина / Контакты» — всегда, тексты из словаря локали', () => {
    for (const locale of LOCALES) {
      const dict = getDictionary(locale);
      const model = build(settings({}), locale);
      expect(model.accountLinks.map((l) => l.label)).toEqual([
        dict.header.favorites,
        dict.header.cart,
        dict.header.contacts,
      ]);
      expect(model.accountLinks[0].href).toBe(menuHref('/favorite', locale));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Низ меню: две почты, телефон — из настроек
// ---------------------------------------------------------------------------

describe('серый низ меню: контакты из настроек магазина, а не литералы', () => {
  it('почта покупателей — settings.contacts.email', () => {
    const model = build(settings({ contacts: { email: 'shop@example.com' } }));
    expect(model.customerEmail).toEqual({
      display: 'shop@example.com',
      href: 'mailto:shop@example.com',
    });
  });

  it('нет contacts.email → фолбэк на branding.supportEmail', () => {
    const model = build(settings({ branding: { supportEmail: 'help@example.com' } }));
    expect(model.customerEmail?.href).toBe('mailto:help@example.com');
  });

  it('почта дизайнеров — settings.legalEntity.emailDesigners (второй блок эталона)', () => {
    const model = build(
      settings({
        contacts: { email: 'shop@example.com' },
        legalEntity: { emailDesigners: 'pro@example.com' },
      }),
    );
    expect(model.designerEmail).toEqual({
      display: 'pro@example.com',
      href: 'mailto:pro@example.com',
    });
  });

  it('🔴 магазин БЕЗ дизайнеров → блока «Для дизайнеров» нет (пустого пункта не рисуем)', () => {
    expect(build(settings({ contacts: { email: 'a@b.co' } })).designerEmail).toBeNull();
    expect(build(settings({ legalEntity: {} })).designerEmail).toBeNull();
    expect(build(null).designerEmail).toBeNull();
  });

  it('почта дизайнеров совпадает с покупательской → второй блок не дублируется', () => {
    const model = build(
      settings({
        contacts: { email: 'one@example.com' },
        legalEntity: { emailDesigners: 'one@example.com' },
      }),
    );
    expect(model.designerEmail).toBeNull();
  });

  it('телефон — settings.contacts.phone, href в tel: только из цифр', () => {
    const model = build(settings({ contacts: { phone: '+7 (905) 043-80-74' } }));
    expect(model.phone).toEqual({
      display: '+7 (905) 043-80-74',
      href: 'tel:+79050438074',
    });
  });

  it('телефона нет → блока телефона нет', () => {
    expect(build(settings({ contacts: {} })).phone).toBeNull();
    expect(build(null).phone).toBeNull();
  });

  for (const locale of LOCALES) {
    it(`${locale}: подписи блоков низа — непустые тексты словаря локали`, () => {
      const dict = getDictionary(locale);
      const model = build(settings({}), locale);
      expect(model.labels.forCustomers).toBe(dict.header.forCustomers);
      expect(model.labels.forDesigners).toBe(dict.header.forDesigners);
      expect(model.labels.phone).toBe(dict.header.phoneWhatsapp);
      for (const value of Object.values(model.labels)) {
        expect(value.trim()).not.toBe('');
      }
    });
  }

  it('en/fr — осмысленный перевод, а не копия русского', () => {
    const ru = getDictionary('ru').header;
    for (const locale of ['en', 'fr'] as const) {
      const d = getDictionary(locale).header;
      for (const key of ['forCustomers', 'forDesigners', 'phoneWhatsapp'] as const) {
        expect(d[key], `${locale}.${key}`).not.toBe(ru[key]);
        expect(d[key], `${locale}.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Переключатели валют и языков в НИЗУ меню (.mm-row)
// ---------------------------------------------------------------------------

describe('переключатели валют/языков дублируются в низу меню (мобильный)', () => {
  it('блок .mm-cur рендерится в меню, а не только в шапке', () => {
    const code = src(HEADER_TSX);
    expect(code).toContain('mm-cur');
    expect(code).toContain('mm-cur__item');
    expect(code).toContain('mm-cur__item--active');
  });

  it('валюта в меню использует ТОТ ЖЕ useCurrency, что и шапка (один источник выбора)', () => {
    const code = src(HEADER_TSX);
    expect(code).toContain('useCurrency');
    // Ровно один вызов хука на компонент: списка валют из двух источников быть не должно.
    expect((code.match(/useCurrency\(/g) ?? []).length).toBe(1);
  });

  it('🔴 ВАЛЮТА НЕ ПО КУКЕ: ни document.cookie, ни перезагрузки страницы', () => {
    // Сторожим ИСПОЛНЯЕМЫЙ код: комментарий обязан объяснять, почему механику
    // эталона (кука + location.reload) мы НЕ повторяем, и упоминает её по имени.
    const code = src(HEADER_TSX)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/document\.cookie/);
    expect(code).not.toMatch(/location\.reload/);
  });

  it('🔴 валюта НЕ связана с языком: переключатель валюты не строит языковых ссылок', () => {
    const code = src(HEADER_TSX);
    // На эталоне .mm-cur вёл на /en/ — у нас это осознанно НЕ так (docs/41 §2 готча).
    const open = code.indexOf('mm-cur');
    expect(open).toBeGreaterThan(-1);
    const block = code.slice(open, open + 900);
    expect(block).not.toContain('langHref');
    expect(block).not.toContain('switchLocalePath');
  });

  it('переключатель валюты показывается, только если валют больше одной', () => {
    const code = src(HEADER_TSX);
    expect(code).toContain('hasMultiCurrency');
  });

  it('языки в меню мапят enabledLocales (выключенный в админке язык не всплывает)', () => {
    const code = src(HEADER_TSX);
    expect((code.match(/enabledLocales\.map/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/LOCALES\.map/);
  });
});

// ---------------------------------------------------------------------------
// 7. Доступность
// ---------------------------------------------------------------------------

describe('меню доступно с клавиатуры', () => {
  const code = src(HEADER_TSX);

  it('раскрытие подразделов — <button> с aria-expanded, а не кликабельный div', () => {
    expect(code).toContain('aria-expanded');
    expect(code).toMatch(/<button[\s\S]*?menu-block-head/);
  });

  it('бургер открытия и крестик закрытия — тоже кнопки (в фокус-порядке)', () => {
    expect(code).toMatch(/<button[\s\S]*?js-menu-open/);
    expect(code).toMatch(/<button[\s\S]*?js-menu-close/);
  });

  it('меню закрывается по Esc', () => {
    expect(code).toMatch(/Escape/);
  });

  it('состояние меню объявлено ассистивным технологиям (aria-hidden/aria-expanded у бургера)', () => {
    expect(code).toMatch(/aria-hidden|aria-expanded/);
  });

  it('переключение валюты — кнопка, а не div с onClick', () => {
    // Кликабельный div без роли/клавиатуры — тот самый дефект доступности.
    expect(code).not.toMatch(/<div[^>]*role="button"/);
  });
});

// ---------------------------------------------------------------------------
// 8. Version skew: меню переживает настройки без секций
// ---------------------------------------------------------------------------

describe('меню не падает на неполных настройках (админка и витрина — разные образы)', () => {
  const cases: [string, PublicSettingsDto | null][] = [
    ['settings === null', null],
    ['пустой объект', settings({})],
    ['navigation без header (старая админка)', settings({ navigation: { footer: [] } })],
    ['legalEntity отсутствует', settings({ contacts: { email: 'a@b.co' } })],
    ['contacts отсутствует', settings({ navigation: { header: [] } })],
    ['header не массив', settings({ navigation: { header: undefined } })],
  ];

  for (const [name, s] of cases) {
    it(`${name} → модель собирается, каталог и группа аккаунта на месте`, () => {
      const model = build(s);
      expect(model.catalog).toHaveLength(3);
      expect(model.accountLinks).toHaveLength(3);
      expect(Array.isArray(model.serviceLinks)).toBe(true);
    });
  }

  it('доступ к настройкам в меню — глубокий optional chaining', () => {
    const code = src(MENU_TS);
    expect(code).not.toMatch(/settings\?\.[a-zA-Z]+\.[a-zA-Z]/);
  });

  it('menuHref — чистая функция того же правила локализации, что и в подвале', () => {
    expect(menuHref('/contacts', 'fr')).toBe('/fr/contacts');
    expect(menuHref('/contacts', 'ru')).toBe('/contacts');
    expect(menuHref('mailto:a@b.co', 'fr')).toBe('mailto:a@b.co');
    expect(menuHref('https://example.com', 'en')).toBe('https://example.com');
    expect(menuHref('#anchor', 'en')).toBe('#anchor');
  });
});
