import { describe, it, expect } from 'vitest';

import { deliverySettingsSchema } from '@/lib/settings/schemas';

/**
 * Зоны доставки (ТЗ_1) — редактируемая из админки зональная цена доставки.
 *
 * `delivery.zones` — универсальный (мультитенант) список зон магазина: каждая
 * зона несёт стабильный id (slug), человекочитаемый label, цену в КОПЕЙКАХ и
 * опциональный порог бесплатной доставки в копейках. Никаких «московских» зон в
 * коде/схеме — это сид-данные конкретного магазина. Как и прочие ключи настроек,
 * объект зоны `.strip()` (анти-tamper JSONB), поле опционально (нет оверрайда →
 * зон нет).
 */
describe('settings/schemas — deliverySettingsSchema.zones', () => {
  it('принимает валидный массив зон (id/label/price + опц. freeThreshold)', () => {
    const parsed = deliverySettingsSchema.parse({
      freeDeliveryThreshold: 0,
      zones: [
        { id: 'mkad_in', label: 'В пределах МКАД', price: 30000 },
        { id: 'mkad_out', label: 'За МКАД + область', price: 50000, freeThreshold: 1000000 },
      ],
    });
    expect(parsed.zones).toHaveLength(2);
    expect(parsed.zones?.[0]).toEqual({ id: 'mkad_in', label: 'В пределах МКАД', price: 30000 });
    expect(parsed.zones?.[1]?.freeThreshold).toBe(1000000);
  });

  it('zones опционально (отсутствие поля валидно)', () => {
    const parsed = deliverySettingsSchema.parse({ freeDeliveryThreshold: 300000 });
    expect(parsed.zones).toBeUndefined();
  });

  it('strip: неизвестные поля зоны отбрасываются (анти-tamper JSONB)', () => {
    const parsed = deliverySettingsSchema.parse({
      zones: [{ id: 'z1', label: 'Зона 1', price: 10000, evil: 'x' }],
    });
    const zone = parsed.zones?.[0] as Record<string, unknown>;
    expect(zone.evil).toBeUndefined();
    expect(zone.price).toBe(10000);
  });

  it('отклоняет отрицательную цену зоны', () => {
    expect(
      deliverySettingsSchema.safeParse({ zones: [{ id: 'z', label: 'l', price: -1 }] }).success,
    ).toBe(false);
  });

  it('отклоняет дробную цену зоны (цена — целые копейки)', () => {
    expect(
      deliverySettingsSchema.safeParse({ zones: [{ id: 'z', label: 'l', price: 10.5 }] }).success,
    ).toBe(false);
  });

  it('отклоняет пустой label зоны', () => {
    expect(
      deliverySettingsSchema.safeParse({ zones: [{ id: 'z', label: '', price: 100 }] }).success,
    ).toBe(false);
  });

  it('отклоняет пустой id зоны', () => {
    expect(
      deliverySettingsSchema.safeParse({ zones: [{ id: '', label: 'l', price: 100 }] }).success,
    ).toBe(false);
  });

  it('отклоняет отрицательный freeThreshold зоны', () => {
    expect(
      deliverySettingsSchema.safeParse({
        zones: [{ id: 'z', label: 'l', price: 100, freeThreshold: -5 }],
      }).success,
    ).toBe(false);
  });
});
