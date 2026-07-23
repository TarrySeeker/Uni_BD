import { describe, it, expect } from 'vitest';

import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  giftSettingsSchema,
  GIFT_SETTINGS_DEFAULTS,
  resolveGiftSettings,
  parseSettingValue,
  isSettingKey,
} from '@/lib/settings/schemas';

/**
 * Схема ключа `gift` (ТЗ владельца п.11 — автовыпуск кода подарочного сертификата).
 *
 * Значение хранит ПОЛИТИКУ выпуска: включён ли автовыпуск при оплате, срок годности
 * кода, какие категории каталога считаются «сертификатами» (мультитенантность: у
 * другого магазина раздел называется иначе), выпускать ли код по заказу, который сам
 * оплачен сертификатом. ВСЕ поля опциональны — отсутствие строки/поля = штатное
 * «нет оверрайда», работают дефолты платформы.
 */
describe('settings/schemas — giftSettingsSchema', () => {
  it('парсит полный валидный объект', () => {
    const parsed = giftSettingsSchema.parse({
      autoIssue: false,
      validDays: 365,
      categorySlugs: ['certificates', 'gift-cards'],
      allowIssueOnGiftPaidOrder: false,
    });
    expect(parsed).toEqual({
      autoIssue: false,
      validDays: 365,
      categorySlugs: ['certificates', 'gift-cards'],
      allowIssueOnGiftPaidOrder: false,
    });
  });

  it('все поля опциональны: пустой объект валиден', () => {
    const parsed = giftSettingsSchema.parse({});
    expect(parsed).toEqual({});
    expect(parsed.autoIssue).toBeUndefined();
    expect(parsed.validDays).toBeUndefined();
    expect(parsed.categorySlugs).toBeUndefined();
    expect(parsed.allowIssueOnGiftPaidOrder).toBeUndefined();
  });

  it('strip: неизвестные поля отбрасываются (анти-tamper JSONB)', () => {
    const parsed = giftSettingsSchema.parse({ autoIssue: true, evil: 'x' }) as Record<
      string,
      unknown
    >;
    expect(parsed.evil).toBeUndefined();
    expect(parsed.autoIssue).toBe(true);
  });

  it('validDays: 0 валиден (бессрочный код)', () => {
    expect(giftSettingsSchema.parse({ validDays: 0 }).validDays).toBe(0);
  });

  it('validDays: null допустим и значит «бессрочно» (в jsonb пишут и 0, и null)', () => {
    // Строгий number|undefined ронял разбор ВСЕГО ключа, и раздел молча
    // возвращался к дефолтам — тот же класс дефекта, что кусал ключ exchange.
    expect(giftSettingsSchema.safeParse({ validDays: null }).success).toBe(true);
    expect(resolveGiftSettings({ validDays: null }).validDays).toBe(0);
    // Соседние поля переживают null: оверрайд владельца не теряется.
    expect(resolveGiftSettings({ validDays: null, autoIssue: false }).autoIssue).toBe(false);
    expect(resolveGiftSettings({ validDays: null, categorySlugs: ['podarki'] }).categorySlugs).toEqual(
      ['podarki'],
    );
  });

  it('validDays: отрицательное/дробное/строка → ошибка валидации', () => {
    expect(giftSettingsSchema.safeParse({ validDays: -1 }).success).toBe(false);
    expect(giftSettingsSchema.safeParse({ validDays: 1.5 }).success).toBe(false);
    expect(giftSettingsSchema.safeParse({ validDays: '365' }).success).toBe(false);
  });

  it('autoIssue / allowIssueOnGiftPaidOrder: не-boolean → ошибка валидации', () => {
    expect(giftSettingsSchema.safeParse({ autoIssue: 'yes' }).success).toBe(false);
    expect(giftSettingsSchema.safeParse({ allowIssueOnGiftPaidOrder: 1 }).success).toBe(false);
  });

  it('categorySlugs: массив непустых строк, пустой массив допустим (автовыпуск некому)', () => {
    expect(giftSettingsSchema.parse({ categorySlugs: [] }).categorySlugs).toEqual([]);
    expect(giftSettingsSchema.safeParse({ categorySlugs: [''] }).success).toBe(false);
    expect(giftSettingsSchema.safeParse({ categorySlugs: 'certificates' }).success).toBe(false);
    expect(giftSettingsSchema.safeParse({ categorySlugs: [1] }).success).toBe(false);
  });

  it('categorySlugs: строки тримятся', () => {
    expect(giftSettingsSchema.parse({ categorySlugs: ['  certificates  '] }).categorySlugs).toEqual(
      ['certificates'],
    );
  });

  it('зарегистрирован в реестре ключей настроек (значит, доступен сброс через resetSetting)', () => {
    expect(SETTING_KEYS).toContain('gift');
    expect(isSettingKey('gift')).toBe(true);
    expect(SETTING_SCHEMAS.gift).toBe(giftSettingsSchema);
  });

  it('parseSettingValue("gift", …): валидное значение → объект, кривое → null', () => {
    expect(parseSettingValue('gift', { autoIssue: false })).toEqual({ autoIssue: false });
    expect(parseSettingValue('gift', { validDays: -5 })).toBeNull();
    // Отсутствие строки в БД (undefined) → пустой оверрайд, а не падение раздела.
    expect(parseSettingValue('gift', undefined)).toEqual({});
  });
});

describe('settings/schemas — дефолты gift и resolveGiftSettings', () => {
  it('дефолты платформы: автовыпуск включён, бессрочно, категория certificates, обмен номинала разрешён', () => {
    expect(GIFT_SETTINGS_DEFAULTS).toEqual({
      autoIssue: true,
      validDays: 0,
      categorySlugs: ['certificates'],
      allowIssueOnGiftPaidOrder: true,
    });
  });

  it('нет оверрайда (undefined/{}/мусор) → дефолты', () => {
    expect(resolveGiftSettings(undefined)).toEqual(GIFT_SETTINGS_DEFAULTS);
    expect(resolveGiftSettings({})).toEqual(GIFT_SETTINGS_DEFAULTS);
    // Кривое значение не роняет раздел — падаем на дефолты.
    expect(resolveGiftSettings({ validDays: -1 })).toEqual(GIFT_SETTINGS_DEFAULTS);
  });

  it('частичный оверрайд мержится по полям (остальные — дефолт)', () => {
    expect(resolveGiftSettings({ autoIssue: false })).toEqual({
      ...GIFT_SETTINGS_DEFAULTS,
      autoIssue: false,
    });
    expect(resolveGiftSettings({ categorySlugs: ['podarok'] })).toEqual({
      ...GIFT_SETTINGS_DEFAULTS,
      categorySlugs: ['podarok'],
    });
  });

  it('пустой список категорий — ЯВНЫЙ оверрайд, а не «нет значения» (дефолт не подставляется)', () => {
    expect(resolveGiftSettings({ categorySlugs: [] }).categorySlugs).toEqual([]);
  });

  it('validDays=0 — явный «бессрочно», не путается с отсутствием поля', () => {
    expect(resolveGiftSettings({ validDays: 0 }).validDays).toBe(0);
    expect(resolveGiftSettings({ validDays: 30 }).validDays).toBe(30);
  });

  it('результат — новый объект: мутация не портит константу дефолтов', () => {
    const a = resolveGiftSettings({});
    a.categorySlugs.push('hacked');
    expect(GIFT_SETTINGS_DEFAULTS.categorySlugs).toEqual(['certificates']);
    expect(resolveGiftSettings({}).categorySlugs).toEqual(['certificates']);
  });
});

describe('settings/schemas — обратная совместимость', () => {
  it('настройки БЕЗ ключа gift парсятся как прежде (остальные ключи не затронуты)', () => {
    for (const key of SETTING_KEYS) {
      // Отсутствие строки в БД не должно ронять раздел: parseSettingValue либо
      // отдаёт объект, либо null (берётся env-дефолт), но никогда не бросает.
      expect(() => parseSettingValue(key, undefined), `ключ ${key}`).not.toThrow();
    }
    // gift специально терпим к пустому значению — все поля опциональны.
    expect(SETTING_SCHEMAS.gift.safeParse({}).success).toBe(true);
  });

  it('gift добавлен, а прежние ключи остались в реестре', () => {
    for (const key of [
      'branding',
      'currency',
      'exchange',
      'units',
      'contacts',
      'legal_entity',
      'catalog',
      'delivery',
      'orders',
      'module_overrides',
      'seo',
      'home',
      'navigation',
      'access',
      'i18n',
    ]) {
      expect(SETTING_KEYS).toContain(key);
    }
  });
});
