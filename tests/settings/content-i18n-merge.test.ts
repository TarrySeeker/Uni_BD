import { describe, it, expect } from 'vitest';

import { mergeSettings } from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';

/**
 * Волна 5, п.5 ТЗ — mergeSettings кладёт в EffectiveSettings сырой оверлей
 * переводов (contentI18n) и набор языков (i18n = конфиг ∩ whitelist ru/en/fr).
 */
function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({
    NODE_ENV: 'test',
    SHOP_NAME: 'EnvShop',
    SHOP_CURRENCY: 'RUB',
    SHOP_NEW_PRODUCT_DAYS: '30',
    SHOP_FREE_DELIVERY_THRESHOLD: '0',
    SHOP_ORDER_PREFIX: '',
    ...overrides,
  });
}

describe('config/settings — content_i18n в mergeSettings', () => {
  it('нет строки content_i18n → contentI18n = {} (переводов нет)', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.contentI18n).toEqual({});
  });

  it('оверлей переводов проносится в эффективные настройки сырым', () => {
    const overlay = { en: { branding: { shopName: 'Shop EN' } } };
    const eff = mergeSettings(envWith(), [{ setting_key: 'content_i18n', value: overlay }]);
    expect(eff.contentI18n).toEqual(overlay);
  });

  it('битый content_i18n (не-объект) → {} (не роняет merge)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'content_i18n', value: 'битьё' as unknown as Record<string, unknown> },
    ]);
    expect(eff.contentI18n).toEqual({});
  });
});

describe('config/settings — i18n в mergeSettings (набор языков ∩ whitelist)', () => {
  it('нет строки i18n → дефолт платформы (ru + [ru,en,fr])', () => {
    const eff = mergeSettings(envWith(), []);
    expect(eff.i18n.defaultLocale).toBe('ru');
    expect(eff.i18n.locales).toEqual(['ru', 'en', 'fr']);
  });

  it('выключение языка в админке убирает его из набора (en выключен → [ru,fr])', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'i18n', value: { defaultLocale: 'ru', locales: ['ru', 'fr'] } },
    ]);
    expect(eff.i18n.locales).toEqual(['ru', 'fr']);
  });

  it('язык вне whitelist платформы отсекается (4-й язык — вне охвата волны)', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'i18n', value: { defaultLocale: 'ru', locales: ['ru', 'en', 'de'] } },
    ]);
    expect(eff.i18n.locales).toEqual(['ru', 'en']);
    expect(eff.i18n.locales).not.toContain('de');
  });

  it('defaultLocale всегда остаётся в наборе', () => {
    const eff = mergeSettings(envWith(), [
      { setting_key: 'i18n', value: { defaultLocale: 'ru', locales: ['ru'] } },
    ]);
    expect(eff.i18n.locales).toContain('ru');
  });
});
