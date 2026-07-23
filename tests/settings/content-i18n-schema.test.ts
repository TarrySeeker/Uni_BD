import { describe, it, expect } from 'vitest';

import {
  parseSettingValue,
  contentI18nSchema,
  SETTINGS_TR_FIELDS,
  SETTING_KEYS,
  SETTING_SCHEMAS,
} from '@/lib/settings/schemas';

/**
 * Волна 5, п.5 ТЗ — оверлей переводов настроек (ключ content_i18n).
 *
 * 🔴 Ключевой инвариант: схема LOOSE. Строгая валидация внутренних полей уронила
 * бы весь ключ на null при малейшем несовпадении формы (класс дефекта exchange/
 * gift — уже ловили дважды), и переводы молча откатились бы на базовый язык.
 */
describe('settings/schemas — content_i18n (LOOSE-оверлей переводов)', () => {
  it('content_i18n зарегистрирован в SETTING_KEYS и SETTING_SCHEMAS', () => {
    expect(SETTING_KEYS).toContain('content_i18n');
    expect(SETTING_SCHEMAS.content_i18n).toBe(contentI18nSchema);
  });

  it('пустой оверлей/отсутствие → {} (обратная совместимость: текущее поведение)', () => {
    expect(parseSettingValue('content_i18n', {})).toEqual({});
    expect(parseSettingValue('content_i18n', undefined)).toEqual({});
    expect(parseSettingValue('content_i18n', null)).toEqual({});
  });

  it('частичный патч сохраняется дословно (свободная вложенная структура)', () => {
    const raw = {
      en: {
        home: { hero: { title: 'Silk' } },
        branding: { shopName: 'Shop EN' },
      },
      fr: { contacts: { address: 'Paris' } },
    };
    expect(parseSettingValue('content_i18n', raw)).toEqual(raw);
  });

  // 🔴 Регресс класса exchange/gift: битый/частичный патч НЕ роняет ключ на null.
  it('битый патч (неожиданные типы полей, лишние ключи) НЕ роняет ключ на дефолты', () => {
    const broken = {
      en: {
        home: { about: { paragraphs: 'не-массив, а строка' } },
        seo: { title_template: 42 },
        мусор: { что: ['угодно'] },
      },
      'weird-locale-key': 'строка вместо объекта-патча',
    };
    const parsed = parseSettingValue('content_i18n', broken);
    // Ключ выжил (не null) — read-path сам безопасно наложит/проигнорирует патч.
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(broken);
  });

  it('верхний уровень обязан быть картой: не-объект → null (падение на {} в merge)', () => {
    expect(parseSettingValue('content_i18n', 'строка')).toBeNull();
    expect(parseSettingValue('content_i18n', 123)).toBeNull();
  });

  it('SETTINGS_TR_FIELDS — источник правды о переводимых полях (плоские ключи)', () => {
    expect(SETTINGS_TR_FIELDS.branding).toContain('shopName');
    expect(SETTINGS_TR_FIELDS.seo).toEqual(
      expect.arrayContaining(['site_name', 'title_template', 'default_description']),
    );
    expect(SETTINGS_TR_FIELDS.contacts).toEqual(
      expect.arrayContaining(['address', 'workingHours']),
    );
  });

  it('SETTINGS_TR_FIELDS описывает и структурные ключи (home/navigation)', () => {
    expect(SETTINGS_TR_FIELDS.home.hero).toEqual(
      expect.arrayContaining(['title', 'subtitle', 'ctaLabel']),
    );
    expect(SETTINGS_TR_FIELDS.home.about).toContain('paragraphs');
    expect(SETTINGS_TR_FIELDS.navigation.header).toContain('label');
    expect(SETTINGS_TR_FIELDS.navigation.footer).toEqual(
      expect.arrayContaining(['title', 'links.label']),
    );
  });

  it('НЕпереводимое (телефон/почта/логотип) в whitelist НЕ попадает', () => {
    expect(SETTINGS_TR_FIELDS.contacts as readonly string[]).not.toContain('phone');
    expect(SETTINGS_TR_FIELDS.contacts as readonly string[]).not.toContain('email');
    expect(SETTINGS_TR_FIELDS.contacts as readonly string[]).not.toContain('socials');
    expect(SETTINGS_TR_FIELDS.branding as readonly string[]).not.toContain('logoUrl');
  });
});
