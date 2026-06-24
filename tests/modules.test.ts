import { describe, it, expect } from 'vitest';
import {
  ALL_MODULES,
  getEnabledModules,
  isModuleEnabled,
  type ModuleName,
} from '@/lib/config/modules';

describe('config/modules', () => {
  it('включает все модули, если ADMIK_MODULES не задан', () => {
    expect(getEnabledModules({})).toEqual([...ALL_MODULES]);
  });

  it('включает все модули, если ADMIK_MODULES пустой', () => {
    expect(getEnabledModules({ ADMIK_MODULES: '   ' })).toEqual([
      ...ALL_MODULES,
    ]);
  });

  it('включает только перечисленные модули', () => {
    const env = { ADMIK_MODULES: 'catalog,orders' };
    expect(getEnabledModules(env)).toEqual(['catalog', 'orders']);
    expect(isModuleEnabled('catalog', env)).toBe(true);
    expect(isModuleEnabled('orders', env)).toBe(true);
    expect(isModuleEnabled('cdek', env)).toBe(false);
    expect(isModuleEnabled('cms', env)).toBe(false);
  });

  it('игнорирует пробелы и регистр', () => {
    const env = { ADMIK_MODULES: ' Catalog , CDEK ' };
    expect(getEnabledModules(env)).toEqual(['catalog', 'cdek']);
  });

  it('игнорирует неизвестные модули', () => {
    const env = { ADMIK_MODULES: 'catalog,unknown,foo' };
    expect(getEnabledModules(env)).toEqual(['catalog']);
  });

  it('убирает дубликаты', () => {
    const env = { ADMIK_MODULES: 'cms,cms,cms' };
    expect(getEnabledModules(env)).toEqual(['cms']);
  });

  it('возвращает false для отключённого модуля при пустом списке известных', () => {
    const env = { ADMIK_MODULES: 'unknown' };
    const result: ModuleName[] = getEnabledModules(env);
    expect(result).toEqual([]);
  });
});
