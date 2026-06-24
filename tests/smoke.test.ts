import { describe, it, expect } from 'vitest';
import { isModuleEnabled, ALL_MODULES } from '@/lib/config/modules';
import { getEnv } from '@/lib/config/env';

/**
 * Smoke-тест: проверяет, что базовые утилиты конфигурации работают вместе.
 * Это минимальная проверка живости фундамента (Этап 0).
 */
describe('smoke', () => {
  it('по умолчанию все модули включены', () => {
    for (const name of ALL_MODULES) {
      expect(isModuleEnabled(name, {})).toBe(true);
    }
  });

  it('getEnv возвращает рабочую конфигурацию по умолчанию', () => {
    const env = getEnv({ NODE_ENV: 'test' });
    expect(env.NODE_ENV).toBe('test');
  });
});
