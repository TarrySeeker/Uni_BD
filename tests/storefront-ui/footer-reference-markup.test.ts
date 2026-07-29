import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildFooterModel, footerHref, telHref } from '../../storefront/lib/footer';
import { getDictionary } from '../../storefront/lib/dictionaries';
import { LOCALES, type Locale } from '../../storefront/lib/i18n';
import type { CategoryDto, PublicSettingsDto } from '../../storefront/lib/types';

/**
 * ПОДВАЛ ВИТРИНЫ = эталон carrerusse.com (docs/41 §1), но БЕЗ хардкода под carre.
 *
 * Два требования тянут в разные стороны и обязаны выполняться ОДНОВРЕМЕННО:
 *  1) разметка/классы/пропорции — как в слепке прода (`.footer-top__subscriptions`
 *     28% · `.footer-soc` · `.footer-top__links` 50% · `.footer-foot`);
 *  2) СОДЕРЖИМОЕ — данные магазина: колонки из settings.navigation.footer,
 *     телефон из settings.contacts, тексты/копирайт/кредит из
 *     settings.navigation.footerMeta. Ни телефона +7 916 336 14 99, ни «Carre
 *     Russe», ни «Pragmatica», ни адресов /catalog/twilly в коде быть не должно —
 *     это содержимое ОДНОГО магазина, а платформа обслуживает многие.
 *
 * Плюс класс дефекта version skew (tests/storefront-ui/settings-version-skew):
 * настройки могут прийти без любой секции — подвал обязан это пережить.
 */

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

const FOOTER_TSX = 'app/[lang]/SiteFooter.tsx';
const FORM_TSX = 'app/[lang]/NewsletterForm.tsx';

/** Дерево категорий магазина (нейтральное, не carre). */
const TREE: CategoryDto[] = [
  { id: '1', slug: 'bags', name: 'Сумки', children: [] },
  { id: '2', slug: 'shoes', name: 'Обувь', children: [] },
] as unknown as CategoryDto[];

function settings(patch: Record<string, unknown> = {}): PublicSettingsDto {
  return patch as unknown as PublicSettingsDto;
}

function build(s: PublicSettingsDto | null, locale: Locale = 'ru') {
  return buildFooterModel({
    categories: TREE,
    tree: TREE,
    settings: s,
    locale,
    dict: getDictionary(locale),
  });
}

// ---------------------------------------------------------------------------
// 1. Разметка = эталон
// ---------------------------------------------------------------------------

describe('разметка подвала повторяет эталон carrerusse.com', () => {
  const code = src(FOOTER_TSX);

  const REQUIRED_CLASSES = [
    'footer',
    'footer-top',
    'footer-top__subscriptions',
    'footer-top__subscriptions-h',
    'footer-soc',
    'footer-soc-icons',
    'footer-soc-phone',
    'footer-top__links',
    'footer-top__links-block',
    'footer-foot',
    'footer-foot-design',
  ];

  for (const cls of REQUIRED_CLASSES) {
    it(`есть класс .${cls}`, () => {
      expect(code).toContain(`"${cls}"`);
    });
  }

  it('форма подписки несёт классы эталона (.footer-top__subscriptions-form, .description, .fp-success)', () => {
    const form = src(FORM_TSX);
    expect(form).toContain('footer-top__subscriptions-form');
    expect(form).toContain('"description"');
    expect(form).toContain('fp-success');
    expect(form).toContain('fp-success__title');
  });

  it('поле ввода и кнопка «Отправить» — внутри одного .footer-top__subscriptions-form, кнопка после поля', () => {
    const form = src(FORM_TSX);
    // Берём ровно фрагмент JSX от открытия блока формы до его закрытия.
    const open = form.indexOf('<div className="footer-top__subscriptions-form">');
    expect(open).toBeGreaterThan(-1);
    const block = form.slice(open, form.indexOf('<div>', open + 1));
    const inputAt = block.indexOf('type="text"');
    const submitAt = block.indexOf('type="submit"');
    expect(inputAt).toBeGreaterThan(-1);
    // Порядок эталона: сначала поле, справа от него кнопка (flex-row).
    expect(submitAt).toBeGreaterThan(inputAt);
  });

  it('прежней самодельной сетки .footer-threads (её нет в /dist/app.css) не осталось', () => {
    expect(code).not.toContain('footer-threads');
  });

  it('классы подвала реально существуют в собранном CSS витрины', () => {
    const css = readFileSync(resolve(STOREFRONT, 'public/dist/app.css'), 'utf8');
    for (const cls of REQUIRED_CLASSES) {
      expect(css, `.${cls} отсутствует в /dist/app.css`).toContain(`.${cls}`);
    }
    // Пропорции эталона: подписка 28%, блок ссылок 50%.
    expect(css).toContain('.footer-top__subscriptions{width:28%}');
    expect(css).toContain('.footer-top__links{display:flex;justify-content:space-between;width:50%}');
  });

  it('адаптив: колонки складываются, CSS для этого уже есть (своих стилей не заводим)', () => {
    const css = readFileSync(resolve(STOREFRONT, 'public/dist/app.css'), 'utf8');
    // Планшет: .footer-top встаёт колонкой, блок ссылок на всю ширину.
    expect(css).toContain('.footer-top{flex-direction:column}');
    expect(css).toMatch(/\.footer-top__links\{[^}]*width:100%/);
    // Мобильный: колонки ссылок переносятся (2 в ряд).
    expect(css).toMatch(/\.footer-top__links\{[^}]*flex-wrap:wrap/);
    // Подвал не тащит собственных стилей помимо собранного дизайна.
    const own = readFileSync(resolve(STOREFRONT, 'public/storefront.css'), 'utf8');
    expect(own).not.toContain('footer-top__');
  });

  /**
   * Телефон в разметке ДВАЖДЫ — так требует CSS эталона: на десктопе видна копия
   * в `.footer-top`, на планшете — копия в `.footer-foot`, на мобильном снова
   * верхняя. Одна копия при любом размещении пропадала бы на части ширин.
   */
  it('телефон продублирован в .footer-top и в .footer-foot — как ожидает CSS эталона', () => {
    const soc = code.match(/className="footer-soc"/g) ?? [];
    expect(soc.length).toBe(2);

    const css = readFileSync(resolve(STOREFRONT, 'public/dist/app.css'), 'utf8');
    // Десктоп прячет нижнюю копию, планшет — верхнюю (иначе телефон двоился бы).
    expect(css).toContain('.footer-foot .footer-soc{display:none}');
    expect(css).toContain('.footer-top .footer-soc{display:none}');
  });
});

// ---------------------------------------------------------------------------
// 2. Мультитенантность: ни одного литерала carre
// ---------------------------------------------------------------------------

describe('в подвале нет содержимого конкретного магазина', () => {
  const files = [FOOTER_TSX, FORM_TSX, 'lib/footer.ts'];

  /**
   * Проверяем ИСПОЛНЯЕМЫЙ код, а не комментарии: документация по правилам проекта
   * ведётся по-русски и законно ссылается на эталон (docs/41) и его примеры.
   * Хардкод же опасен именно в коде — туда содержимое одного магазина попасть
   * не должно.
   */
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Телефон/бренд/студия/адреса разделов эталона — это данные ОДНОГО магазина.
  const FORBIDDEN = [
    /916\s*336/,
    /79163361499/,
    /carre/i,
    /pragmatica/i,
    /Стефани|Сенешаль/i,
    /\/catalog\/twilly/,
    /platki-i-sharfi/,
  ];

  for (const rel of files) {
    for (const pattern of FORBIDDEN) {
      it(`${rel} не содержит ${pattern} в коде`, () => {
        expect(stripComments(src(rel))).not.toMatch(pattern);
      });
    }
  }

  it('в JSX подвала нет русских литералов (все тексты — из словаря/настроек)', () => {
    for (const rel of [FOOTER_TSX, FORM_TSX]) {
      const cyrillicStrings =
        stripComments(src(rel)).match(/(['"`])[^'"`\n]*[А-Яа-яЁё][^'"`\n]*\1/g) ?? [];
      expect(cyrillicStrings, `${rel}: русские литералы в коде`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Колонки — из настроек магазина
// ---------------------------------------------------------------------------

describe('колонки подвала приходят из settings.navigation.footer', () => {
  it('заданные владельцем колонки рендерятся В ТОМ ЖЕ порядке и составе', () => {
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [
            { title: 'Каталог', links: [{ label: 'Сумки', href: '/catalog/bags' }] },
            {
              title: 'Помощь',
              links: [
                { label: 'Доставка', href: '/about#delivery' },
                { label: 'Оплата', href: '/about#pay' },
              ],
            },
          ],
        },
      }),
    );
    expect(model.columns).toHaveLength(2);
    expect(model.columns[0].links.map((l) => l.label)).toEqual(['Сумки']);
    expect(model.columns[1].links.map((l) => l.label)).toEqual(['Доставка', 'Оплата']);
  });

  it('число колонок не зафиксировано в коде: 4 колонки эталона проходят как есть', () => {
    const footer = ['A', 'B', 'C', 'D'].map((t) => ({
      title: t,
      links: [{ label: `${t}-1`, href: `/${t}` }],
    }));
    const model = build(settings({ navigation: { header: [], footer } }));
    expect(model.columns).toHaveLength(4);
  });

  it('колонка без единой валидной ссылки в разметку не идёт', () => {
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [
            { title: 'Пустая', links: [] },
            { title: 'Битая', links: [{ label: '', href: '/x' }] },
            { title: 'Живая', links: [{ label: 'Ок', href: '/ok' }] },
          ],
        },
      }),
    );
    expect(model.columns.map((c) => c.key)).toEqual(['Живая']);
  });

  it('владелец навигацию не заполнил → универсальный дефолт платформы с РЕАЛЬНЫМИ категориями магазина', () => {
    const model = build(settings({ navigation: { header: [], footer: [] } }));
    expect(model.columns.length).toBeGreaterThan(0);
    const catalogColumn = model.columns[0];
    expect(catalogColumn.links.map((l) => l.label)).toEqual(['Сумки', 'Обувь']);
  });

  it('🔴 навигация есть, но ВСЕ ссылки битые → дефолт, а не подвал без единой ссылки', () => {
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [
            { title: 'A', links: [{ label: 'X', href: '' }] },
            { title: 'B', links: [] },
          ],
        },
      }),
    );
    expect(model.columns.length).toBeGreaterThan(0);
    expect(model.columns.every((c) => c.links.length > 0)).toBe(true);
  });

  it('внутренние пути локализуются, внешние адреса остаются нетронутыми', () => {
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [
            {
              title: 'Смесь',
              links: [
                { label: 'Внутр', href: '/about' },
                { label: 'Внешн', href: 'https://example.com/x' },
                { label: 'Почта', href: 'mailto:a@b.co' },
                { label: 'Якорь', href: '#anchor' },
              ],
            },
          ],
        },
      }),
      'en',
    );
    const hrefs = model.columns[0].links.map((l) => l.href);
    expect(hrefs[0]).toBe('/en/about');
    expect(hrefs[1]).toBe('https://example.com/x');
    expect(hrefs[2]).toBe('mailto:a@b.co');
    expect(hrefs[3]).toBe('#anchor');
  });

  it('footerHref — чистая функция того же правила', () => {
    expect(footerHref('/contacts', 'fr')).toBe('/fr/contacts');
    expect(footerHref('/contacts', 'ru')).toBe('/contacts');
    expect(footerHref('tel:+7999', 'fr')).toBe('tel:+7999');
    expect(footerHref('//cdn.example.com/x', 'fr')).toBe('//cdn.example.com/x');
  });
});

// ---------------------------------------------------------------------------
// 4. Телефон, копирайт, кредит — из настроек
// ---------------------------------------------------------------------------

describe('телефон подвала — из настроек магазина', () => {
  it('берётся settings.contacts.phone и превращается в корректный tel:', () => {
    const model = build(settings({ contacts: { phone: '+7 (916) 336 14 99' } }));
    expect(model.phone).toEqual({
      display: '+7 (916) 336 14 99',
      href: 'tel:+79163361499',
    });
  });

  it('нет contacts.phone → фолбэк на branding.supportPhone', () => {
    const model = build(settings({ branding: { supportPhone: '8 800 000 00 00' } }));
    expect(model.phone?.href).toBe('tel:88000000000');
  });

  it('телефон не задан вовсе → блока телефона нет (выдумывать нечего)', () => {
    expect(build(settings({ contacts: {} })).phone).toBeNull();
    expect(build(settings({})).phone).toBeNull();
    expect(build(null).phone).toBeNull();
  });

  it('telHref: только цифры и ведущий плюс; без цифр — пустая ссылка', () => {
    expect(telHref('+33 1 23 45 67 89')).toBe('tel:+33123456789');
    expect(telHref('8 (800) 555-35-35')).toBe('tel:88005553535');
    expect(telHref('позвоните нам')).toBe('');
  });
});

describe('копирайт и кредит студии — настройки, а не литералы', () => {
  it('копирайт берётся из navigation.footerMeta.copyright', () => {
    const model = build(
      settings({
        branding: { shopName: 'Магазин' },
        navigation: { header: [], footer: [], footerMeta: { copyright: '2026 © Мой Дом' } },
      }),
    );
    expect(model.copyright).toBe('2026 © Мой Дом');
  });

  it('копирайт не задан → имя магазина из брендинга (а не чужой бренд)', () => {
    const model = build(settings({ branding: { shopName: 'Магазин' } }));
    expect(model.copyright).toBe('Магазин');
  });

  it('ни копирайта, ни имени магазина → пусто', () => {
    expect(build(settings({})).copyright).toBe('');
  });

  it('кредит студии рендерится ТОЛЬКО когда владелец его задал', () => {
    expect(build(settings({})).designedBy).toBeNull();
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [],
          footerMeta: {
            designedByLabel: 'Designed by — Studio',
            designedByHref: 'https://studio.example',
          },
        },
      }),
    );
    expect(model.designedBy).toEqual({
      label: 'Designed by — Studio',
      href: 'https://studio.example',
    });
  });

  it('кредит без ссылки — валиден (рендерится текстом)', () => {
    const model = build(
      settings({
        navigation: { header: [], footer: [], footerMeta: { designedByLabel: 'Studio' } },
      }),
    );
    expect(model.designedBy).toEqual({ label: 'Studio', href: '' });
  });
});

// ---------------------------------------------------------------------------
// 5. Подписка: тексты из настроек/словаря
// ---------------------------------------------------------------------------

describe('форма подписки: заголовок и приписка настраиваются, дефолт — словарный', () => {
  it('владелец задал свой заголовок и приписку', () => {
    const model = build(
      settings({
        navigation: {
          header: [],
          footer: [],
          footerMeta: {
            subscribeTitle: 'Рассылка от Стефани',
            subscribeNote: 'Согласие на обработку данных',
          },
        },
      }),
    );
    expect(model.subscribe.title).toBe('Рассылка от Стефани');
    expect(model.subscribe.note).toBe('Согласие на обработку данных');
  });

  for (const locale of LOCALES) {
    it(`${locale}: настройки пусты → непустые тексты подписки из словаря локали`, () => {
      const model = build(settings({}), locale);
      const dict = getDictionary(locale);
      expect(model.subscribe.title).toBe(dict.footer.subscribeTitle);
      expect(model.subscribe.placeholder).toBe(dict.footer.subscribePlaceholder);
      expect(model.subscribe.submitLabel).toBe(dict.footer.subscribeSubmit);
      expect(model.subscribe.note).toBe(dict.footer.subscribeNote);
      expect(model.subscribe.successTitle).toBe(dict.footer.subscribeSuccess);
      for (const value of Object.values(model.subscribe)) {
        expect(value.trim()).not.toBe('');
      }
    });
  }

  it('en/fr — осмысленный перевод, а не копия русского', () => {
    const ru = getDictionary('ru').footer;
    for (const locale of ['en', 'fr'] as const) {
      const d = getDictionary(locale).footer;
      for (const key of [
        'subscribeTitle',
        'subscribePlaceholder',
        'subscribeSubmit',
        'subscribeNote',
        'subscribeSuccess',
        'subscribeError',
        'subscribeInvalid',
        'subscribeAria',
      ] as const) {
        expect(d[key], `${locale}.${key}`).not.toBe(ru[key]);
        // Кириллицы в en/fr быть не должно.
        expect(d[key], `${locale}.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Подписка использует СУЩЕСТВУЮЩИЙ эндпоинт платформы
// ---------------------------------------------------------------------------

describe('подписка переиспользует существующий приёмник, а не заводит второй', () => {
  it('витрина шлёт в POST /api/storefront/v1/newsletter через общий apiPost', () => {
    const api = src('lib/api.ts');
    expect(api).toMatch(/export async function subscribeNewsletter/);
    expect(api).toMatch(/apiPost<[^>]*>\('\/newsletter'/);
  });

  it('форма не ходит в сеть в обход клиента API (никаких своих fetch/URL)', () => {
    const form = src(FORM_TSX);
    expect(form).toContain('subscribeNewsletter');
    expect(form).not.toMatch(/\bfetch\s*\(/);
    expect(form).not.toMatch(/https?:\/\//);
  });

  it('в приложении ровно ОДИН публичный роут подписки', () => {
    const routes = readFileSync(
      resolve(__dirname, '../../app/api/storefront/v1/newsletter/route.ts'),
      'utf8',
    );
    // Роут-приёмник существует и защищён общим конвейером (auth → rate-limit → CORS).
    expect(routes).toContain('runStorefront');
    expect(routes).toContain('NewsletterInputSchema');
    expect(routes).toContain('subscribe(');
  });

  it('адрес подписчика не логируется ни на витрине, ни в роуте', () => {
    const form = src(FORM_TSX);
    expect(form).not.toMatch(/console\.(log|info|warn|error)/);
    const route = readFileSync(
      resolve(__dirname, '../../app/api/storefront/v1/newsletter/route.ts'),
      'utf8',
    );
    // В логер уходит только текст ошибки, но не parsed.data.email.
    expect(route).not.toMatch(/logger\.[a-z]+\([^)]*email/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Version skew: подвал переживает настройки без секций
// ---------------------------------------------------------------------------

describe('подвал не падает на неполных настройках (админка и витрина — разные образы)', () => {
  const cases: [string, PublicSettingsDto | null][] = [
    ['settings === null', null],
    ['пустой объект', settings({})],
    ['navigation без footerMeta (старая админка)', settings({ navigation: { header: [], footer: [] } })],
    ['navigation отсутствует', settings({ branding: { shopName: 'X' }, contacts: {} })],
    ['contacts отсутствует', settings({ navigation: { header: [], footer: [] } })],
    ['socials не массив', settings({ contacts: { socials: undefined } })],
  ];

  for (const [name, s] of cases) {
    it(`${name} → модель собирается, колонки непусты`, () => {
      const model = build(s);
      expect(model.columns.length).toBeGreaterThan(0);
      expect(typeof model.copyright).toBe('string');
      expect(model.subscribe.title.trim()).not.toBe('');
    });
  }

  it('доступ к настройкам в подвале — глубокий optional chaining', () => {
    const code = src('lib/footer.ts');
    // Ни одного `settings?.секция.поле` (защита только от null у корня).
    expect(code).not.toMatch(/settings\?\.[a-zA-Z]+\.[a-zA-Z]/);
  });

  it('битые соцсети отбрасываются, а не рендерятся дырами', () => {
    const model = build(
      settings({
        contacts: {
          socials: [
            { type: 'instagram', url: 'https://inst.example' },
            { type: '', url: 'https://x.example' },
            { type: 'vk', url: '' },
          ],
        },
      }),
    );
    expect(model.socials).toEqual([{ type: 'instagram', url: 'https://inst.example' }]);
  });
});
