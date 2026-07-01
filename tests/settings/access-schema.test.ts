import { describe, it, expect } from 'vitest';

import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  accessSchema,
  parseSettingValue,
  isSettingKey,
} from '@/lib/settings/schemas';

/**
 * Схема ключа `access` (B9 — однопользовательский режим).
 *
 * `access.value` хранит флаги доступа уровня магазина. Сейчас единственный флаг —
 * singleUserMode (скрывает/блокирует управление пользователями и ролями для
 * конкретного инстанса). Дефолт OFF (поле опционально, мерж даёт false) —
 * мультитенантность: другие магазины не затронуты без явного включения.
 */
describe('settings/schemas — accessSchema', () => {
  it('парсит { singleUserMode: true }', () => {
    const parsed = accessSchema.parse({ singleUserMode: true });
    expect(parsed.singleUserMode).toBe(true);
  });

  it('singleUserMode опционально (отсутствие поля валидно)', () => {
    const parsed = accessSchema.parse({});
    expect(parsed.singleUserMode).toBeUndefined();
  });

  it('strip: неизвестные поля отбрасываются (анти-tamper JSONB)', () => {
    const parsed = accessSchema.parse({ singleUserMode: false, evil: 'x' }) as Record<
      string,
      unknown
    >;
    expect(parsed.evil).toBeUndefined();
    expect(parsed.singleUserMode).toBe(false);
  });

  it('singleUserMode не-boolean → ошибка валидации', () => {
    expect(accessSchema.safeParse({ singleUserMode: 'yes' }).success).toBe(false);
  });

  it('зарегистрирован в реестре ключей настроек', () => {
    expect(SETTING_KEYS).toContain('access');
    expect(isSettingKey('access')).toBe(true);
    expect(SETTING_SCHEMAS.access).toBe(accessSchema);
  });

  it('parseSettingValue("access", …) возвращает провалидированный объект', () => {
    expect(parseSettingValue('access', { singleUserMode: true })).toEqual({
      singleUserMode: true,
    });
    // Кривое значение → null (раздел игнорируется, остаётся дефолт).
    expect(parseSettingValue('access', { singleUserMode: 123 })).toBeNull();
  });
});
