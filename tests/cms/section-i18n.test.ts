/**
 * T5 — перевод ТЕЛА CMS-страницы (контент секций cms_page_sections).
 *
 * Read-path уже умеет: lib/storefront/cms-dto.ts прогоняет content секции через
 * localizeStructured (deep-merge оверлея translations[locale] поверх базового
 * content). Write-path не было: upsertCmsSection не писал колонку translations.
 *
 * Здесь проверяется СИММЕТРИЯ: то, что читается локализованным, принимается на
 * входе и сохраняется в ТОЙ ЖЕ структурной форме. Тесты чистые (без БД/React).
 */

import { describe, it, expect } from 'vitest';

import {
  SECTION_TR_FIELD_SPECS,
  SECTION_TRANSLATION_MAX_BYTES,
  buildSectionTranslationPatch,
  sectionTranslationsFormState,
  resolveSectionTranslationsUpdate,
  existingSectionTranslations,
  sectionLocaleTabs,
} from '@/lib/cms/section-i18n';
import { SECTION_FIELD_SPECS } from '@/lib/cms/section-form';
import { CMS_SECTION_TYPES, type CmsSectionType } from '@/lib/cms/types';
import { CMS_SECTION_TR_FIELDS } from '@/lib/i18n/fields';
import { localizeStructured } from '@/lib/i18n';
import type { LocaleConfig, TranslationsMap } from '@/lib/i18n';
import { CmsError } from '@/lib/cms/errors';

const CFG: LocaleConfig = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };

/** Локализация как на витрине (cms-dto → localizeStructured). */
function asStorefront(
  content: Record<string, unknown>,
  translations: TranslationsMap,
  locale: string,
): Record<string, unknown> {
  return localizeStructured(content, translations, locale, CFG.defaultLocale) as Record<
    string,
    unknown
  >;
}

describe('CMS_SECTION_TR_FIELDS — whitelist переводимых полей секции', () => {
  it('покрывает все типы секций без пропусков', () => {
    for (const type of CMS_SECTION_TYPES) {
      expect(Array.isArray(CMS_SECTION_TR_FIELDS[type])).toBe(true);
    }
    expect(Object.keys(CMS_SECTION_TR_FIELDS).sort()).toEqual([...CMS_SECTION_TYPES].sort());
  });

  it('каждое переводимое поле реально существует в форме секции (нет полей-призраков)', () => {
    for (const type of CMS_SECTION_TYPES) {
      const formNames = SECTION_FIELD_SPECS[type].map((f) => f.name);
      for (const name of CMS_SECTION_TR_FIELDS[type]!) {
        expect(formNames).toContain(name);
      }
    }
  });

  it('машинные поля не переводимы: ссылки, ключи изображений, режим/лимит подборки', () => {
    const forbidden = [
      'imageKey',
      'images.imageKey',
      'ctaHref',
      'href',
      'buttonHref',
      'mode',
      'limit',
      'slugs',
      'categorySlug',
      'brandSlug',
    ];
    for (const type of CMS_SECTION_TYPES) {
      for (const name of CMS_SECTION_TR_FIELDS[type]!) {
        expect(forbidden).not.toContain(name);
      }
    }
  });

  it('SECTION_TR_FIELD_SPECS (UI) совпадает по составу с whitelist (симметрия форма↔запись)', () => {
    for (const type of CMS_SECTION_TYPES) {
      expect(SECTION_TR_FIELD_SPECS[type].map((f) => f.name)).toEqual([
        ...CMS_SECTION_TR_FIELDS[type]!,
      ]);
    }
  });
});

describe('buildSectionTranslationPatch — форма → структурный патч content', () => {
  it('text: html попадает в патч и переопределяет базу на витрине', () => {
    const base = { type: 'text', html: '<p>Оплата картой</p>' };
    const patch = buildSectionTranslationPatch('text', { html: '<p>Card payment</p>' });
    expect(patch).toEqual({ html: '<p>Card payment</p>' });

    const en = asStorefront(base, { en: patch }, 'en');
    expect(en).toEqual({ type: 'text', html: '<p>Card payment</p>' });
  });

  it('hero: переводятся тексты, а ссылка и ключ картинки берутся из базы', () => {
    const base = {
      type: 'hero',
      title: 'Платки',
      subtitle: 'Шёлк',
      html: '<p>Из Франции</p>',
      imageKey: 'cms/hero.webp',
      ctaLabel: 'В каталог',
      ctaHref: '/catalog',
    };
    const patch = buildSectionTranslationPatch('hero', {
      title: 'Scarves',
      subtitle: 'Silk',
      html: '<p>From France</p>',
      ctaLabel: 'To catalog',
      // машинные поля даже если пришли — не переводятся (см. отдельный тест)
    });
    const en = asStorefront(base, { en: patch }, 'en');
    expect(en.title).toBe('Scarves');
    expect(en.subtitle).toBe('Silk');
    expect(en.html).toBe('<p>From France</p>');
    expect(en.ctaLabel).toBe('To catalog');
    expect(en.ctaHref).toBe('/catalog');
    expect(en.imageKey).toBe('cms/hero.webp');
    expect(en.type).toBe('hero');
  });

  it('faq: пары «вопрос|ответ» переводятся ПО ИНДЕКСУ, пустая строка оставляет базу', () => {
    const base = {
      type: 'faq',
      items: [
        { q: 'Есть доставка?', a: '<p>Да</p>' },
        { q: 'Возврат?', a: '<p>14 дней</p>' },
      ],
    };
    // Вторая пара не переведена — строка пустая, но позиция сохранена.
    const patch = buildSectionTranslationPatch('faq', {
      items: 'Delivery?|<p>Yes</p>\n|',
    });
    const en = asStorefront(base, { en: patch }, 'en') as { items: { q: string; a: string }[] };
    expect(en.items[0]).toEqual({ q: 'Delivery?', a: '<p>Yes</p>' });
    expect(en.items[1]).toEqual({ q: 'Возврат?', a: '<p>14 дней</p>' });
  });

  it('gallery: переводится только alt, ключи изображений сохраняются', () => {
    const base = {
      type: 'gallery',
      images: [
        { imageKey: 'cms/a.webp', alt: 'Красный платок' },
        { imageKey: 'cms/b.webp', alt: 'Синий платок' },
      ],
    };
    const patch = buildSectionTranslationPatch('gallery', { images: 'Red scarf\nBlue scarf' });
    const en = asStorefront(base, { en: patch }, 'en') as {
      images: { imageKey: string; alt: string }[];
    };
    expect(en.images[0]).toEqual({ imageKey: 'cms/a.webp', alt: 'Red scarf' });
    expect(en.images[1]).toEqual({ imageKey: 'cms/b.webp', alt: 'Blue scarf' });
  });

  it('products_grid: переводится заголовок, фильтр товаров остаётся машинным', () => {
    const base = {
      type: 'products_grid',
      mode: 'category',
      categorySlug: 'scarves',
      limit: 12,
      title: 'Новинки',
    };
    const patch = buildSectionTranslationPatch('products_grid', { title: 'New arrivals' });
    expect(patch).toEqual({ title: 'New arrivals' });
    const en = asStorefront(base, { en: patch }, 'en');
    expect(en.title).toBe('New arrivals');
    expect(en.categorySlug).toBe('scarves');
    expect(en.limit).toBe(12);
  });

  it('пустые значения не попадают в патч (витрина откатится на базовый язык)', () => {
    const patch = buildSectionTranslationPatch('cta', {
      title: '   ',
      html: '',
      buttonLabel: 'Buy',
    });
    expect(patch).toEqual({ buttonLabel: 'Buy' });
  });

  it('rich-text перевода САНИТИЗИРУЕТСЯ (клиенту не доверяем)', () => {
    const patch = buildSectionTranslationPatch('text', {
      html: '<p onclick="alert(1)">Hi</p><script>alert(2)</script>',
    });
    const html = String(patch.html);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('Hi');
  });

  it('ответ FAQ тоже санитизируется', () => {
    const patch = buildSectionTranslationPatch('faq', {
      items: 'Q|<p>ok</p><script>alert(1)</script>',
    });
    expect(JSON.stringify(patch)).not.toContain('<script');
  });
});

describe('sectionTranslationsFormState — оверлей → состояние формы (round-trip)', () => {
  it('плоские поля восстанавливаются как есть', () => {
    const tr: TranslationsMap = { en: { title: 'Scarves', html: '<p>Hi</p>' } };
    const state = sectionTranslationsFormState('hero', tr);
    expect(state.en!.title).toBe('Scarves');
    expect(state.en!.html).toBe('<p>Hi</p>');
  });

  it('faq: массив пар сериализуется обратно в multiline и переживает round-trip', () => {
    const patch = buildSectionTranslationPatch('faq', { items: 'Q1|<p>A1</p>\n|<p>A2</p>' });
    const state = sectionTranslationsFormState('faq', { en: patch });
    expect(state.en!.items).toBe('Q1|<p>A1</p>\n|<p>A2</p>');
    expect(buildSectionTranslationPatch('faq', state.en!)).toEqual(patch);
  });

  it('gallery: alt-тексты сериализуются построчно', () => {
    const patch = buildSectionTranslationPatch('gallery', { images: 'Red\nBlue' });
    const state = sectionTranslationsFormState('gallery', { en: patch });
    expect(state.en!.images).toBe('Red\nBlue');
  });

  it('чужие/структурно неожиданные ключи в форму не протекают', () => {
    const state = sectionTranslationsFormState('text', {
      en: { html: '<p>Hi</p>', imageKey: 'cms/x.webp' },
    });
    expect(state.en).toEqual({ html: '<p>Hi</p>' });
  });
});

describe('resolveSectionTranslationsUpdate — write-path (что пишем в колонку)', () => {
  it('блока нет → provided=false, существующий оверлей не тронут', () => {
    const existing: TranslationsMap = { en: { html: '<p>old</p>' } };
    const res = resolveSectionTranslationsUpdate('text', undefined, existing, CFG);
    expect(res.provided).toBe(false);
    expect(res.value).toEqual(existing);
  });

  it('пишет только переданный язык, соседний не затирается', () => {
    const existing: TranslationsMap = { fr: { html: '<p>fr</p>' } };
    const res = resolveSectionTranslationsUpdate(
      'text',
      { en: { html: '<p>en</p>' } },
      existing,
      CFG,
    );
    expect(res.provided).toBe(true);
    expect(res.value).toEqual({ fr: { html: '<p>fr</p>' }, en: { html: '<p>en</p>' } });
    // Иммутабельность: вход не мутирован.
    expect(existing).toEqual({ fr: { html: '<p>fr</p>' } });
  });

  it('язык вне набора магазина отсекается', () => {
    const res = resolveSectionTranslationsUpdate(
      'text',
      { de: { html: '<p>de</p>' } },
      null,
      CFG,
    );
    expect(res.value.de).toBeUndefined();
    expect(res.provided).toBe(false);
  });

  it('базовый язык (defaultLocale) в оверлей не пишется — база живёт в колонках', () => {
    const res = resolveSectionTranslationsUpdate(
      'text',
      { ru: { html: '<p>ru</p>' } },
      null,
      CFG,
    );
    expect(res.value.ru).toBeUndefined();
    expect(res.provided).toBe(false);
  });

  it('лишние (не-whitelist) поля отсекаются', () => {
    const res = resolveSectionTranslationsUpdate(
      'hero',
      { en: { title: 'Scarves', imageKey: 'cms/evil.webp', ctaHref: 'javascript:alert(1)' } },
      null,
      CFG,
    );
    expect(res.value.en).toEqual({ title: 'Scarves' });
  });

  it('очистка всех полей языка удаляет его из оверлея (витрина вернётся на базу)', () => {
    const existing: TranslationsMap = { en: { html: '<p>en</p>' }, fr: { html: '<p>fr</p>' } };
    const res = resolveSectionTranslationsUpdate('text', { en: { html: '' } }, existing, CFG);
    expect(res.provided).toBe(true);
    expect(res.value).toEqual({ fr: { html: '<p>fr</p>' } });
  });

  it('мультитенантность: набор языков берётся из конфига магазина, а не хардкодом', () => {
    const cfg: LocaleConfig = { defaultLocale: 'en', locales: ['en', 'de'] };
    const res = resolveSectionTranslationsUpdate(
      'text',
      { de: { html: '<p>de</p>' }, en: { html: '<p>en</p>' }, fr: { html: '<p>fr</p>' } },
      null,
      cfg,
    );
    expect(Object.keys(res.value)).toEqual(['de']);
  });

  it('слишком длинный перевод отвергается (защита размера JSONB, как CHECK на content)', () => {
    const huge = `<p>${'a'.repeat(SECTION_TRANSLATION_MAX_BYTES + 1000)}</p>`;
    expect(() =>
      resolveSectionTranslationsUpdate('text', { en: { html: huge } }, null, CFG),
    ).toThrow(CmsError);
  });

  it('нестроковое значение перевода отвергается явной ошибкой, а не молча', () => {
    expect(() =>
      resolveSectionTranslationsUpdate('text', { en: { html: { evil: 1 } } }, null, CFG),
    ).toThrow(CmsError);
  });
});

describe('existingSectionTranslations — смена типа секции обнуляет чужой оверлей', () => {
  const tr: TranslationsMap = { en: { html: '<p>en</p>' } };

  it('тип не менялся → существующий оверлей сохраняется', () => {
    expect(existingSectionTranslations('text', 'text', tr)).toEqual(tr);
  });

  it('тип сменился → оверлей сбрасывается (поля старого типа больше не валидны)', () => {
    expect(existingSectionTranslations('text', 'gallery', tr)).toEqual({});
  });

  it('новой секции (прежнего типа нет) соответствует пустой оверлей', () => {
    expect(existingSectionTranslations(undefined, 'text', null)).toEqual({});
  });
});

describe('sectionLocaleTabs — вкладки языков секции', () => {
  it('дефолтный язык первый, дубли схлопываются', () => {
    expect(sectionLocaleTabs(['en', 'ru', 'fr', 'en'], 'ru')).toEqual(['ru', 'en', 'fr']);
  });

  it('один язык магазина → одна вкладка (панель перевода не нужна)', () => {
    expect(sectionLocaleTabs(['ru'], 'ru')).toEqual(['ru']);
  });
});

describe('симметрия read/write по всем типам секций', () => {
  const cases: Record<CmsSectionType, { base: Record<string, unknown>; form: Record<string, string> }> =
    {
      hero: {
        base: { type: 'hero', title: 'Т', subtitle: 'П', html: '<p>Х</p>', ctaLabel: 'К', ctaHref: '/c' },
        form: { title: 'T', subtitle: 'S', html: '<p>H</p>', ctaLabel: 'C' },
      },
      text: { base: { type: 'text', html: '<p>Х</p>' }, form: { html: '<p>H</p>' } },
      banner: {
        base: { type: 'banner', imageKey: 'cms/b.webp', alt: 'Баннер' },
        form: { alt: 'Banner' },
      },
      products_grid: {
        base: { type: 'products_grid', mode: 'slugs', slugs: ['a'], limit: 4, title: 'Н' },
        form: { title: 'New' },
      },
      faq: {
        base: { type: 'faq', items: [{ q: 'В', a: '<p>О</p>' }] },
        form: { items: 'Q|<p>A</p>' },
      },
      cta: {
        base: { type: 'cta', title: 'Т', html: '<p>Х</p>', buttonLabel: 'К', buttonHref: '/c' },
        form: { title: 'T', html: '<p>H</p>', buttonLabel: 'B' },
      },
      gallery: {
        base: { type: 'gallery', images: [{ imageKey: 'cms/a.webp', alt: 'А' }] },
        form: { images: 'A' },
      },
    };

  for (const type of CMS_SECTION_TYPES) {
    it(`${type}: каждое поле whitelist доезжает до витрины, дискриминатор type не переводится`, () => {
      const { base, form } = cases[type];
      const res = resolveSectionTranslationsUpdate(type, { en: form }, null, CFG);
      const en = asStorefront(base, res.value, 'en');
      expect(en.type).toBe(type);
      for (const [k, v] of Object.entries(form)) {
        if (k === 'items' || k === 'images') continue; // структурные — проверены выше
        expect(en[k]).toBe(v);
      }
      // Базовый язык витрины остаётся неизменным.
      expect(asStorefront(base, res.value, 'ru')).toEqual(base);
    });
  }
});
