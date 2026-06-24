import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  getEffectiveSettings,
  invalidateSettingsCache,
} from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';
import { fromMinor } from '@/lib/orders/money';

/**
 * Тест пакета 5.D-2 (docs/11 §5.4.4) — обратная совместимость репозиториев при
 * пустой БД. Источник newProductDays/freeDeliveryThreshold меняется
 * getEnv() → getEffectiveSettings(), КОНТРАКТ значения не меняется: при пустой БД
 * эффективные настройки = env-дефолт (fallback). Деньги конвертируются обратно в
 * рубли через fromMinor на границе legacy numeric-репозиториев.
 */

function envWith(overrides: Record<string, string | undefined> = {}) {
  return getEnv({
    NODE_ENV: 'test',
    SHOP_NAME: 'EnvShop',
    SHOP_CURRENCY: 'RUB',
    SHOP_NEW_PRODUCT_DAYS: '45',
    SHOP_FREE_DELIVERY_THRESHOLD: '3000',
    SHOP_ORDER_PREFIX: 'GA',
    ...overrides,
  });
}

describe('settings — обратная совместимость репозиториев (пустая БД → env)', () => {
  afterEach(() => invalidateSettingsCache());

  it('пустая БД: newProductDays = env-дефолт', async () => {
    const eff = await getEffectiveSettings({ readRows: vi.fn(async () => []), env: envWith() });
    expect(eff.catalog.newProductDays).toBe(45);
  });

  it('пустая БД: freeDeliveryThreshold (копейки) ↔ env-рубли через fromMinor', async () => {
    const eff = await getEffectiveSettings({ readRows: vi.fn(async () => []), env: envWith() });
    // env задаёт 3000 руб → 300000 коп; обратно в рубли = '3000.00'.
    expect(eff.delivery.freeDeliveryThreshold).toBe(300000);
    expect(fromMinor(eff.delivery.freeDeliveryThreshold)).toBe('3000.00');
  });

  it('БД-оверрайд freeDeliveryThreshold (копейки) перекрывает env', async () => {
    const eff = await getEffectiveSettings({
      readRows: vi.fn(async () => [
        { setting_key: 'delivery', value: { freeDeliveryThreshold: 150000 } },
      ]),
      env: envWith(),
    });
    expect(eff.delivery.freeDeliveryThreshold).toBe(150000);
    expect(fromMinor(eff.delivery.freeDeliveryThreshold)).toBe('1500.00');
  });
});
