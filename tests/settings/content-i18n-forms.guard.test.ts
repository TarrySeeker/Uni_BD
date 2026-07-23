import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD по разметке форм настроек с редактором ПЕРЕВОДОВ (волна 5, трек C).
 * Тестов React-компонентов нет (vitest env 'node'): сторожим СУТЬ модели —
 *   • перевод уходит ОТДЕЛЬНЫМ слоем (SettingsTranslationTabs → updateContentI18n),
 *     а НЕ через базовый action формы (иначе следующее базовое сохранение сотрёт
 *     перевод — этого мы и избегаем всей моделью);
 *   • базовые (русские) поля правятся ПРЕЖНИМ путём (базовый action на месте);
 *   • набор языков и оверлей приходят со страницы пропсами (i18n/translations),
 *     без хардкода языков в форме.
 */

const BASE = resolve(__dirname, '../../app/admin/(panel)/settings/_components');
const read = (f: string) => readFileSync(resolve(BASE, f), 'utf8');

const forms = {
  branding: read('BrandingForm.tsx'),
  seo: read('SeoSettingsForm.tsx'),
  contacts: read('LegalContactsForm.tsx'),
  home: read('HomeContentForm.tsx'),
  navigation: read('NavigationForm.tsx'),
};

const wrapper = read('SettingsTranslationTabs.tsx');

describe('редактор переводов — обёртка SettingsTranslationTabs', () => {
  it('сохраняет перевод через updateContentI18n, НЕ через базовый action', () => {
    expect(wrapper).toContain('updateContentI18n');
    expect(wrapper).toContain('buildContentI18nSaves');
    // Антипаттерн: перевод не должен уходить базовыми экшенами настроек.
    expect(wrapper).not.toMatch(/updateHome|updateBranding|updateShopSeo|updateNavigation|updateLegal/);
  });

  it('набор языков — обязательные пропсы locales/defaultLocale (без хардкода ru/en/fr)', () => {
    expect(wrapper).toMatch(/locales:\s*readonly string\[\]/);
    expect(wrapper).toMatch(/defaultLocale:\s*string/);
    expect(wrapper).not.toMatch(/\[\s*'ru'\s*,\s*'en'\s*,\s*'fr'\s*\]/);
  });

  it('пре-заполняется из существующего оверлея (initTrState)', () => {
    expect(wrapper).toContain('initTrState');
  });
});

describe('редактор переводов — все пять форм подключают слой перевода', () => {
  for (const [name, src] of Object.entries(forms)) {
    it(`${name}: обёрнута в SettingsTranslationTabs с языками и оверлеем`, () => {
      expect(src).toContain('SettingsTranslationTabs');
      expect(src).toContain('locales={i18n.locales}');
      expect(src).toContain('defaultLocale={i18n.defaultLocale}');
      expect(src).toContain('translations={translations}');
    });

    it(`${name}: базовый action формы сохранён (русские поля правятся прежним путём)`, () => {
      // У каждой формы остаётся её родной базовый мутатор.
      const baseActions = /update(Home|Branding|ShopSeo|LegalContacts|Navigation)/;
      expect(src).toMatch(baseActions);
    });
  }
});

describe('редактор переводов — правильная секция и whitelist полей', () => {
  it('branding → секция branding + BRANDING_TR_FIELD_DEFS', () => {
    expect(forms.branding).toContain('section="branding"');
    expect(forms.branding).toContain('BRANDING_TR_FIELD_DEFS');
  });

  it('seo → секция seo + SEO_TR_FIELD_DEFS', () => {
    expect(forms.seo).toContain('section="seo"');
    expect(forms.seo).toContain('SEO_TR_FIELD_DEFS');
  });

  it('contacts → секция contacts + CONTACTS_TR_FIELD_DEFS', () => {
    expect(forms.contacts).toContain('section="contacts"');
    expect(forms.contacts).toContain('CONTACTS_TR_FIELD_DEFS');
  });

  it('home → секция home + динамические дескрипторы buildHomeTrFieldDefs', () => {
    expect(forms.home).toContain('section="home"');
    expect(forms.home).toContain('buildHomeTrFieldDefs');
  });

  it('navigation → секция navigation + buildNavigationTrFieldDefs', () => {
    expect(forms.navigation).toContain('section="navigation"');
    expect(forms.navigation).toContain('buildNavigationTrFieldDefs');
  });
});

describe('редактор переводов — страницы прокидывают конфигурацию языков', () => {
  const settingsPage = readFileSync(
    resolve(__dirname, '../../app/admin/(panel)/settings/page.tsx'),
    'utf8',
  );
  const seoPage = readFileSync(
    resolve(__dirname, '../../app/admin/(panel)/settings/seo/page.tsx'),
    'utf8',
  );

  it('страница настроек передаёт eff.i18n и eff.contentI18n формам', () => {
    expect(settingsPage).toContain('i18n={eff.i18n}');
    expect(settingsPage).toContain('translations={eff.contentI18n}');
  });

  it('страница SEO передаёт конфигурацию языков форме', () => {
    expect(seoPage).toContain('i18n={eff.i18n}');
    expect(seoPage).toContain('translations={eff.contentI18n}');
  });
});
