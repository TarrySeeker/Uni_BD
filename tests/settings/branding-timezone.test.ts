import { describe, expect, it } from 'vitest';

import { brandingSchema, parseSettingValue } from '@/lib/settings/schemas';

/**
 * Аудит major №26 — часовой пояс магазина как НАСТРОЙКА, а не хардкод.
 *
 * Пояс живёт в существующем ключе `branding` (раздел «идентичность магазина»):
 * новая строка SETTING_KEYS не нужна, значит не нужна и миграция — shop_settings
 * это jsonb key/value (0019), а сид 0020 лишь заводит пустые строки для UI.
 * Поле опционально: магазины, у которых его нет, падают на env/дефолт платформы,
 * и старые сохранённые значения branding остаются валидными.
 */

describe('settings/schemas — branding.timeZone', () => {
  it('принимает IANA-идентификатор пояса', () => {
    const parsed = brandingSchema.safeParse({ timeZone: 'Europe/Paris' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timeZone).toBe('Europe/Paris');
  });

  it('поле опционально — старые значения branding остаются валидными', () => {
    const parsed = brandingSchema.safeParse({ shopName: 'Carre' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timeZone).toBeUndefined();
  });

  it('пустой объект валиден (нет оверрайда → env/дефолт платформы)', () => {
    expect(brandingSchema.safeParse({}).success).toBe(true);
  });

  it('пробелы обрезаются', () => {
    const parsed = brandingSchema.safeParse({ timeZone: '  Asia/Yekaterinburg  ' });
    expect(parsed.success && parsed.data.timeZone).toBe('Asia/Yekaterinburg');
  });

  it('пустая строка отклоняется (пусто = «не задано», а не «пояс без имени»)', () => {
    expect(brandingSchema.safeParse({ timeZone: '   ' }).success).toBe(false);
  });

  it('проходит через parseSettingValue вместе с остальными полями branding', () => {
    const value = parseSettingValue('branding', {
      shopName: 'Carre',
      timeZone: 'Europe/Moscow',
    });
    expect(value?.timeZone).toBe('Europe/Moscow');
  });
});
