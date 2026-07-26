import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Настоящий резолвер Next — оракул того, как строка-заголовок пройдёт через
// title.template корневого layout (там имя магазина из настроек и появляется).
import { resolveTitle } from 'next/dist/lib/metadata/resolvers/resolve-title';

import { getDictionary } from '../../storefront/lib/dictionaries';
import { metaTitle, ownTitle, rootTitle } from '../../storefront/lib/seo';
import type { Locale } from '../../storefront/lib/i18n';
import type { PublicSettingsDto } from '../../storefront/lib/types';

/**
 * ТЕХ-ДОЛГ (docs/32 §5): имя магазина «carre» было ЗАШИТО в словарные заголовки
 * витрины («Заказ оформлен — carre», «Товар не найден — carre», …, 12 вхождений
 * в ru/en/fr). Два следствия:
 *  1) мультитенантность: чужой магазин на этой платформе получал бы «— carre»;
 *  2) как только владелец задаст осмысленный titleTemplate в админке, шаблон Next
 *     доклеит имя ВТОРОЙ раз: «Заказ оформлен — carre — Carré Russe».
 * Правило: словарь даёт только СМЫСЛ страницы, имя магазина приезжает из настроек
 * ровно один раз — через title.template корневого layout.
 */

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');
const LOCALES: Locale[] = ['ru', 'en', 'fr'];

function settings(seo: Partial<PublicSettingsDto['seo']>): PublicSettingsDto {
  return {
    seo: {
      siteName: null,
      siteUrl: null,
      titleTemplate: '%s',
      defaultDescription: null,
      twitterSite: null,
      ...seo,
    },
  } as PublicSettingsDto;
}

describe('словарь витрины не содержит имени магазина в заголовках', () => {
  it('в lib/dictionaries.ts нет суффикса «— carre» / «- carre» (ни в строках, ни в комментариях-примерах)', () => {
    const hits = src('lib/dictionaries.ts').match(/[—–-]\s*carre/gi) ?? [];
    expect(hits).toEqual([]);
  });

  // ВСЕ словарные строки, которые уходят в Metadata.title страниц витрины
  // (см. generateMetadata: cart/success, [slug], product, designers, catalog,
  // catalog/[...slug], cart/order, search). Пустая тут = пустой <title>, а при
  // осмысленном titleTemplate — висящий суффикс вида ' — Carré Russe'.
  const titleKeys: Array<[keyof ReturnType<typeof getDictionary>, string]> = [
    ['success', 'metaTitle'],
    ['notFound', 'pageMetaTitle'],
    ['notFound', 'productMetaTitle'],
    ['notFound', 'designerMetaTitle'],
    ['catalog', 'title'],
    ['checkout', 'title'],
    ['search', 'title'],
    ['search', 'resultsFor'],
  ];

  for (const locale of LOCALES) {
    for (const [group, key] of titleKeys) {
      it(`${locale}.${String(group)}.${key} — только смысл страницы, без имени магазина`, () => {
        const dict = getDictionary(locale) as unknown as Record<string, Record<string, string>>;
        const value = dict[String(group)][key];
        expect(value).toBeTruthy();
        expect(value.toLowerCase()).not.toContain('carre');
      });
    }
  }
});

describe('имя магазина доклеивается ровно один раз — шаблоном из настроек', () => {
  const TEMPLATE = '%s — Carré Russe';

  for (const locale of LOCALES) {
    it(`${locale}: словарный заголовок 404 + шаблон владельца = один суффикс`, () => {
      const own = getDictionary(locale).notFound.pageMetaTitle;
      const resolved = resolveTitle(own, TEMPLATE);
      expect(resolved.absolute).toBe(`${own} — Carré Russe`);
      // Ни одного двойного суффикса.
      expect(resolved.absolute.match(/Carré Russe/g)).toHaveLength(1);
    });

    it(`${locale}: заголовок страницы успеха + шаблон владельца = один суффикс`, () => {
      const own = getDictionary(locale).success.metaTitle;
      expect(resolveTitle(own, TEMPLATE).absolute).toBe(`${own} — Carré Russe`);
    });

    it(`${locale}: владелец шаблон не задал → чистый смысл страницы без чужого бренда`, () => {
      const own = getDictionary(locale).notFound.pageMetaTitle;
      expect(resolveTitle(own, '%s').absolute).toBe(own);
    });
  }

  it('страницы отдают словарный заголовок СТРОКОЙ (absolute обошёл бы шаблон)', () => {
    for (const rel of [
      'app/[lang]/cart/success/page.tsx',
      'app/[lang]/product/[slug]/page.tsx',
      'app/[lang]/[slug]/page.tsx',
      'app/[lang]/designers/[slug]/page.tsx',
    ]) {
      const code = src(rel);
      // Нет ручной склейки имени магазина на витрине.
      expect(code).not.toMatch(/MetaTitle\s*\+/);
      expect(code).not.toMatch(/\{\s*absolute:\s*(get)?[Dd]ict/);
    }
  });
});

/**
 * docs/32 §14.4 п.4: при двух пустых источниках metaTitle отдавал `{ absolute: '' }`,
 * и Next не рендерил <title> ВООБЩЕ (пустой absolute побеждает title.default
 * родительского layout — см. resolve-title.js). Фолбэк — имя сайта из настроек.
 */
describe('metaTitle: пустые источники → имя сайта из настроек, а не пропавший <title>', () => {
  const s = settings({ siteName: 'Carré Russe', titleTemplate: '%s — Carré Russe' });

  it('оба источника пусты + настройки есть → absolute с именем сайта', () => {
    expect(metaTitle(null, null, s)).toEqual({ absolute: 'Carré Russe' });
    expect(metaTitle('', '   ', s)).toEqual({ absolute: 'Carré Russe' });
  });

  it('<title> реально отрендерится (resolveTitle Next даёт непустой absolute)', () => {
    const resolved = resolveTitle(metaTitle(null, null, s), '%s — Carré Russe');
    expect(resolved.absolute).toBe('Carré Russe');
    // Имя сайта не должно продублироваться шаблоном.
    expect(resolved.absolute.match(/Carré Russe/g)).toHaveLength(1);
  });

  it('настроек нет вовсе → пустой absolute (выдумывать чужое имя нельзя)', () => {
    expect(metaTitle(null, null, null)).toEqual({ absolute: '' });
    expect(metaTitle(null, null)).toEqual({ absolute: '' });
    // Ничего не потеряно: в ТОМ ЖЕ состоянии (API настроек недоступен) корневой
    // layout резолвится в пустой заголовок тоже — брать имя магазина негде.
    expect(resolveTitle(rootTitle(null), null).absolute).toBe('');
  });

  it('непустые источники фолбэк не задействуют', () => {
    expect(metaTitle('Готовый | X', 'Товар', s)).toEqual({ absolute: 'Готовый | X' });
    expect(metaTitle(null, 'Товар', s)).toBe('Товар');
  });

  it('корневой layout всё равно даёт имя сайта в title.default', () => {
    expect(rootTitle(s)).toEqual({ default: 'Carré Russe', template: '%s — Carré Russe' });
  });
});

/**
 * Настройки ПРИШЛИ, но SEO-блок владелец не заполнял: `seo.siteName = null` —
 * штатное состояние провода (сервер: `seo.site_name ?? branding-override ??
 * env.SHOP_NAME`), тогда как имя магазина всегда есть в `branding.shopName`.
 * Раньше эта ветка давала `{ absolute: '' }` → <title> не рендерился вообще.
 */
describe('<title> не пустеет, когда seo.siteName пуст, а имя магазина есть в branding', () => {
  const TEMPLATE = '%s — Carré Russe';
  const s = {
    seo: {
      siteName: null,
      siteUrl: null,
      titleTemplate: TEMPLATE,
      defaultDescription: null,
      twitterSite: null,
    },
    branding: { shopName: 'Carré Russe' },
  } as unknown as PublicSettingsDto;

  it('оба источника пусты → absolute с именем магазина из branding', () => {
    expect(metaTitle(null, null, s)).toEqual({ absolute: 'Carré Russe' });
    expect(metaTitle('', '   ', s)).toEqual({ absolute: 'Carré Russe' });
  });

  it('корневой layout: title.default = имя магазина, шаблон СВОЙ default не трогает', () => {
    // stashedTemplate корневого layout = null (шаблон родителя), поэтому его
    // собственный '%s — …' к default НЕ применяется: висящего суффикса нет.
    const resolved = resolveTitle(rootTitle(s), null);
    expect(resolved.absolute).toBe('Carré Russe');
    expect(resolved.absolute.match(/Carré Russe/g)).toHaveLength(1);
    expect(resolved.template).toBe(TEMPLATE);
  });

  it('ни одна ветка metaTitle не даёт пустой <title> и не двоит имя магазина', () => {
    const sources: (string | null | undefined)[] = [null, undefined, '', '   ', 'Твилли микро'];
    for (const server of sources) {
      for (const own of sources) {
        const resolved = resolveTitle(metaTitle(server, own, s), TEMPLATE);
        expect(resolved.absolute, `server=${server}, own=${own}`).not.toBe('');
        // Класс дефекта C (docs/32 §11): суффикс ровно один раз или ни разу.
        expect((resolved.absolute.match(/Carré Russe/g) ?? []).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('серверный заголовок с УЖЕ применённым шаблоном не получает второй суффикс', () => {
    const fromApi = `Твилли микро — Carré Russe`;
    const resolved = resolveTitle(metaTitle(fromApi, 'Твилли микро', s), TEMPLATE);
    expect(resolved.absolute).toBe(fromApi);
    expect(resolved.absolute.match(/Carré Russe/g)).toHaveLength(1);
  });
});

/**
 * Последняя ветка, где <title> мог опустеть: страница отдаёт СТРОКОЙ имя сущности
 * (категория каталога). Пустое имя прошло бы через title.template и дало висящий
 * суффикс (' — Carré Russe') либо пустой <title>. Правило то же, что у metaTitle:
 * пустое/пробельное/чужого типа значение = «значения нет» → берётся фолбэк.
 */
describe('ownTitle — собственный заголовок страницы строкой, без пустоты', () => {
  it('первый осмысленный кандидат', () => {
    expect(ownTitle('Платки', 'Каталог')).toBe('Платки');
    expect(ownTitle(null, 'Каталог')).toBe('Каталог');
    expect(ownTitle(undefined, 'Каталог')).toBe('Каталог');
    expect(ownTitle('', 'Каталог')).toBe('Каталог');
    expect(ownTitle('   ', 'Каталог')).toBe('Каталог');
  });

  it('обрезает пробелы (в шаблон уходит чистая строка)', () => {
    expect(ownTitle('  Платки  ', 'Каталог')).toBe('Платки');
  });

  it('все кандидаты пусты → пустая строка (и это единственный такой случай)', () => {
    expect(ownTitle(null, undefined, '  ')).toBe('');
  });

  it('прогон настоящим resolveTitle: висящего суффикса не остаётся', () => {
    const TEMPLATE = '%s — Carré Russe';
    expect(resolveTitle(ownTitle('', 'Каталог'), TEMPLATE).absolute).toBe('Каталог — Carré Russe');
  });

  it('категория без имени берёт заголовок каталога (страница catalog/[...slug])', () => {
    const code = src('app/[lang]/catalog/[...slug]/page.tsx');
    // Заголовок остаётся СТРОКОЙ (шаблон Next ему нужен), но пустым не бывает.
    expect(code).toMatch(/title:\s*ownTitle\(/);
    expect(code).not.toMatch(/title:\s*cat\s*\?/);
  });
});

describe('страницы с серверным meta.* передают настройки в metaTitle (фолбэк работает)', () => {
  for (const rel of [
    'app/[lang]/product/[slug]/page.tsx',
    'app/[lang]/[slug]/page.tsx',
    'app/[lang]/designers/[slug]/page.tsx',
  ]) {
    it(`${rel} — третий аргумент settings передан`, () => {
      const code = src(rel);
      const calls = code.match(/metaTitle\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/,\s*settings\s*\)$/);
      }
    });
  }
});
