import { describe, it, expect } from 'vitest';

import {
  assemblePatch,
  flattenOverlay,
  hasAnyTranslation,
  buildContentI18nSaves,
  initTrState,
  buildHomeTrFieldDefs,
  buildNavigationTrFieldDefs,
  BRANDING_TR_FIELD_DEFS,
  SEO_TR_FIELD_DEFS,
  CONTACTS_TR_FIELD_DEFS,
} from '@/app/admin/(panel)/settings/_components/content-i18n-form-state';
import { SETTINGS_TR_FIELDS, contentI18nSchema } from '@/lib/settings/schemas';
import { ContentI18nInputSchema } from '@/lib/settings/action-factory';

/**
 * Волна 5, трек C — чистая логика редактора ПЕРЕВОДОВ настроек (ключ content_i18n).
 * Тестов React-форм нет (vitest env 'node'): формы — тонкие обёртки над этими
 * функциями, суть проверяем здесь + guard'ом по разметке.
 */

describe('content-i18n-form-state — assemblePatch (плоский путь → вложенный патч)', () => {
  it('плоские поля секции (branding/seo) кладутся как есть', () => {
    expect(assemblePatch({ shopName: 'Silk' })).toEqual({ shopName: 'Silk' });
    expect(
      assemblePatch({ site_name: 'Шёлк', title_template: '%s — Шёлк' }),
    ).toEqual({ site_name: 'Шёлк', title_template: '%s — Шёлк' });
  });

  it('вложенные пути строят объекты (home.hero.title)', () => {
    expect(assemblePatch({ 'hero.title': 'Silk', 'hero.subtitle': 'Fine' })).toEqual({
      hero: { title: 'Silk', subtitle: 'Fine' },
    });
  });

  it('числовой сегмент строит массив по индексу (about.paragraphs)', () => {
    expect(
      assemblePatch({ 'about.paragraphs.0': 'p1', 'about.paragraphs.1': 'p2' }),
    ).toEqual({ about: { paragraphs: ['p1', 'p2'] } });
  });

  it('массив объектов по индексу (delivery.items[i].title/text)', () => {
    expect(
      assemblePatch({
        'delivery.items.0.title': 'CDEK',
        'delivery.items.0.text': 'Fast',
      }),
    ).toEqual({ delivery: { items: [{ title: 'CDEK', text: 'Fast' }] } });
  });

  it('глубокая вложенность массивов (footer[i].links[j].label)', () => {
    expect(assemblePatch({ 'footer.1.links.2.label': 'Contacts' })).toEqual({
      footer: [undefined, { links: [undefined, undefined, { label: 'Contacts' }] }],
    });
  });

  it('пустые/пробельные значения ОТБРАСЫВАЮТСЯ (пустой перевод не мусорит патч)', () => {
    expect(assemblePatch({ 'hero.title': '   ', 'hero.subtitle': 'Fine' })).toEqual({
      hero: { subtitle: 'Fine' },
    });
    expect(assemblePatch({ shopName: '' })).toEqual({});
  });

  it('значения тримятся', () => {
    expect(assemblePatch({ shopName: '  Silk  ' })).toEqual({ shopName: 'Silk' });
  });
});

describe('content-i18n-form-state — flattenOverlay (вложенный оверлей → плоский путь)', () => {
  it('обратна assemblePatch на строковых листах', () => {
    const overlay = {
      hero: { title: 'Silk' },
      about: { paragraphs: ['p1', 'p2'] },
    };
    const flat = flattenOverlay(overlay);
    expect(flat).toEqual({
      'hero.title': 'Silk',
      'about.paragraphs.0': 'p1',
      'about.paragraphs.1': 'p2',
    });
    expect(assemblePatch(flat)).toEqual(overlay);
  });

  it('нестроковые листы игнорируются (href/enabled/числа в патч не попадают)', () => {
    expect(
      flattenOverlay({ hero: { title: 'Silk', enabled: true, order: 3 } }),
    ).toEqual({ 'hero.title': 'Silk' });
  });

  it('битый/непонятный оверлей → пустая карта, без исключения', () => {
    expect(flattenOverlay('мусор')).toEqual({});
    expect(flattenOverlay(null)).toEqual({});
    expect(flattenOverlay(undefined)).toEqual({});
  });
});

describe('content-i18n-form-state — hasAnyTranslation', () => {
  it('true только при наличии непустого значения', () => {
    expect(hasAnyTranslation({ a: 'x' })).toBe(true);
    expect(hasAnyTranslation({ a: '', b: '   ' })).toBe(false);
    expect(hasAnyTranslation({})).toBe(false);
    expect(hasAnyTranslation(undefined)).toBe(false);
  });
});

describe('content-i18n-form-state — initTrState (оверлей → состояние формы)', () => {
  it('извлекает патч секции для каждого языка', () => {
    const overlay = {
      en: { branding: { shopName: 'Silk' }, seo: { site_name: 'Silk EN' } },
      fr: { branding: { shopName: 'Soie' } },
    };
    expect(initTrState(overlay, 'branding')).toEqual({
      en: { shopName: 'Silk' },
      fr: { shopName: 'Soie' },
    });
    expect(initTrState(overlay, 'seo')).toEqual({ en: { site_name: 'Silk EN' } });
  });

  it('нет оверлея → пустое состояние', () => {
    expect(initTrState(undefined, 'branding')).toEqual({});
    expect(initTrState({}, 'branding')).toEqual({});
  });
});

describe('content-i18n-form-state — buildContentI18nSaves (состояние → вызовы действия)', () => {
  it('один вызов на язык с собранным патчем секции', () => {
    const saves = buildContentI18nSaves('branding', {
      en: { shopName: 'Silk' },
      fr: { shopName: 'Soie' },
    });
    expect(saves).toEqual([
      { locale: 'en', section: 'branding', patch: { shopName: 'Silk' } },
      { locale: 'fr', section: 'branding', patch: { shopName: 'Soie' } },
    ]);
  });

  it('каждый вызов проходит схему входа действия (форма ↔ контракт трека A)', () => {
    const saves = buildContentI18nSaves('home', {
      en: { 'hero.title': 'Silk', 'about.paragraphs.0': 'p1' },
    });
    expect(saves).toHaveLength(1);
    expect(ContentI18nInputSchema.safeParse(saves[0]).success).toBe(true);
    expect(saves[0].patch).toEqual({ hero: { title: 'Silk' }, about: { paragraphs: ['p1'] } });
  });

  it('очистка перевода: пустое состояние языка даёт пустой патч (сброс на базу)', () => {
    const saves = buildContentI18nSaves('branding', { en: { shopName: '' } });
    expect(saves).toEqual([{ locale: 'en', section: 'branding', patch: {} }]);
  });
});

describe('content-i18n-form-state — whitelist переводимых полей', () => {
  it('плоские дескрипторы совпадают с SETTINGS_TR_FIELDS (единый источник)', () => {
    expect(BRANDING_TR_FIELD_DEFS.map((f) => f.key)).toEqual([...SETTINGS_TR_FIELDS.branding]);
    expect(SEO_TR_FIELD_DEFS.map((f) => f.key)).toEqual([...SETTINGS_TR_FIELDS.seo]);
    expect(CONTACTS_TR_FIELD_DEFS.map((f) => f.key)).toEqual([...SETTINGS_TR_FIELDS.contacts]);
  });

  it('ни один дескриптор не тянет непереводимое поле (href/imageKey)', () => {
    const home = buildHomeTrFieldDefs({
      hero: { title: 't', subtitle: 's', ctaLabel: 'c', ctaHref: '/x', imageKey: 'k' },
      about: { title: 'a', paragraphs: ['p'], values: ['v'], imageKeys: ['k'] },
      quality: { title: 'q', items: ['i'] },
      delivery: { items: [{ title: 'dt', text: 'dx' }] },
      valuesStrip: { enabled: true, items: [{ title: 'vt', text: 'vx' }] },
      philosophy: { eyebrow: 'e', title: 'pt', text: 'px', linkLabel: 'll', linkHref: '/l' },
      looks: { enabled: true, title: 'lt', categories: [{ title: 'ct', text: 'cx', imageKey: 'k' }] },
      tiles: { enabled: true, items: [{ title: 'tt', href: '/t', imageKey: 'k' }] },
      video: { enabled: false, embedUrl: '' },
      designers: {
        enabled: true,
        title: 'dt',
        items: [{ name: 'n', href: '/d', avatarImageKey: 'a', workImageKey: 'w', avatarTop: 50, workTop: 50 }],
      },
      slider: { enabled: true, slides: [{ imageKey: 'k', href: '/s', name: 'sn', caption: 'sc' }] },
      corpCert: { enabled: true, tiles: [{ imageKey: 'k', href: '/c', title: 'ct' }] },
    });
    const keys = home.map((f) => f.key);
    expect(keys).not.toContain('hero.ctaHref');
    expect(keys).not.toContain('hero.imageKey');
    expect(keys.some((k) => /href|imageKey|embedUrl|enabled/i.test(k))).toBe(false);
    // Переводимые листы присутствуют.
    expect(keys).toContain('hero.title');
    expect(keys).toContain('about.paragraphs.0');
    expect(keys).toContain('delivery.items.0.title');
    expect(keys).toContain('slider.slides.0.caption');
  });

  it('home-дескрипторы разворачиваются по фактической длине базовых массивов', () => {
    const home = buildHomeTrFieldDefs({
      hero: {}, about: { paragraphs: ['a', 'b', 'c'] }, quality: {}, delivery: {},
      valuesStrip: {}, philosophy: {}, looks: {}, tiles: {}, video: {},
      designers: {}, slider: {}, corpCert: {},
    });
    const paras = home.filter((f) => f.key.startsWith('about.paragraphs.'));
    expect(paras.map((f) => f.key)).toEqual([
      'about.paragraphs.0',
      'about.paragraphs.1',
      'about.paragraphs.2',
    ]);
  });

  it('navigation-дескрипторы: метки шапки + заголовки/ссылки колонок футера', () => {
    const nav = buildNavigationTrFieldDefs({
      header: [{ label: 'Каталог', href: '/c' }],
      footer: [{ title: 'Магазин', links: [{ label: 'Доставка', href: '/d' }] }],
    });
    const keys = nav.map((f) => f.key);
    expect(keys).toContain('header.0.label');
    expect(keys).toContain('footer.0.title');
    expect(keys).toContain('footer.0.links.0.label');
    expect(keys.some((k) => /href/i.test(k))).toBe(false);
  });
});

describe('content-i18n-form-state — совместимость со схемой ключа', () => {
  it('карта {locale: patch} принимается loose-схемой content_i18n', () => {
    const overlay = { en: { branding: { shopName: 'Silk' } } };
    expect(contentI18nSchema.safeParse(overlay).success).toBe(true);
  });
});
