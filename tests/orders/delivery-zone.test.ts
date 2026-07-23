import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  UnknownDeliveryZoneError,
  resolveDeliveryZone,
  resolveDeliveryZoneStrict,
  resolveZonePricing,
  type DeliveryZoneConfig,
} from '@/lib/orders/delivery-cost';
import { mapOrder } from '@/lib/orders/repository';
import { toOrderPublicDto } from '@/lib/storefront/order-dto';

/**
 * ТЗ владельца п.9 — зоны доставки (в пределах МКАД / за МКАД).
 *
 * Здесь: (а) СТРОГОЕ разрешение зоны (неизвестный zoneId больше не проваливается
 * молча в stub 0.00 — anti-undercharge), (б) чистый расчёт порога бесплатной
 * доставки для quote, (в) сохранение зоны в заказе (mapOrder/DTO),
 * (г) guard-тесты по исходникам: INSERT заказа, витрина, миграция 0053.
 */

const ROOT = resolve(__dirname, '../..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const ZONES: DeliveryZoneConfig[] = [
  { id: 'zone_in', label: 'В пределах МКАД', price: 50000 },
  { id: 'zone_out', label: 'За МКАД', price: 150000, freeThreshold: 2000000 },
];

// =============================================================================
// (а) Строгое разрешение зоны.
// =============================================================================
describe('resolveDeliveryZoneStrict — строгое разрешение зоны', () => {
  it('известный id → зона из настроек магазина', () => {
    const z = resolveDeliveryZoneStrict({ zoneId: 'zone_in', zones: ZONES });
    expect(z?.id).toBe('zone_in');
    expect(z?.price).toBe(50000);
  });

  it('неизвестный id при непустом списке зон → явная ошибка (а не тихий 0.00)', () => {
    expect(() => resolveDeliveryZoneStrict({ zoneId: 'nope', zones: ZONES })).toThrow(
      UnknownDeliveryZoneError,
    );
  });

  it('zoneId отсутствует → undefined (прежнее поведение, СДЭК/stub)', () => {
    expect(resolveDeliveryZoneStrict({ zones: ZONES })).toBeUndefined();
    expect(resolveDeliveryZoneStrict({ zoneId: '', zones: ZONES })).toBeUndefined();
  });

  it('у магазина зон нет → zoneId игнорируется, ошибки нет (зональный режим выключен)', () => {
    expect(resolveDeliveryZoneStrict({ zoneId: 'zone_in', zones: [] })).toBeUndefined();
    expect(resolveDeliveryZoneStrict({ zoneId: 'zone_in' })).toBeUndefined();
  });

  it('семантика мягкого resolveDeliveryZone НЕ изменилась (её же зовёт ветка СДЭК)', () => {
    expect(resolveDeliveryZone({ zoneId: 'nope', zones: ZONES })).toBeUndefined();
    expect(resolveDeliveryZone({ zoneId: 'zone_in', zones: ZONES })?.id).toBe('zone_in');
  });
});

// =============================================================================
// (б) Порог бесплатной доставки для quote (чистая функция; quoteCart её зовёт).
// =============================================================================
describe('resolveZonePricing — порог бесплатной доставки по зоне', () => {
  it('зона со своим порогом перекрывает общий порог магазина', () => {
    const r = resolveZonePricing({ zoneId: 'zone_out', zones: ZONES, shopFreeThresholdMinor: 100 });
    expect(r.unknown).toBe(false);
    expect(r.zone?.id).toBe('zone_out');
    expect(r.freeThresholdMinor).toBe(2000000);
  });

  it('зона без своего порога → общий порог магазина', () => {
    const r = resolveZonePricing({ zoneId: 'zone_in', zones: ZONES, shopFreeThresholdMinor: 300000 });
    expect(r.freeThresholdMinor).toBe(300000);
  });

  it('без zoneId → общий порог магазина (поведение не меняется)', () => {
    const r = resolveZonePricing({ zones: ZONES, shopFreeThresholdMinor: 300000 });
    expect(r.unknown).toBe(false);
    expect(r.zone).toBeUndefined();
    expect(r.freeThresholdMinor).toBe(300000);
  });

  it('неизвестный zoneId → unknown и НУЛЕВОЙ порог (quote не даёт бесплатную доставку)', () => {
    const r = resolveZonePricing({ zoneId: 'nope', zones: ZONES, shopFreeThresholdMinor: 1 });
    expect(r.unknown).toBe(true);
    expect(r.zone).toBeUndefined();
    // 0 → calculateQuote трактует порог как «недостижимый» (Infinity), free=false.
    expect(r.freeThresholdMinor).toBe(0);
  });
});

// =============================================================================
// (в) Сохранение зоны в заказе: mapOrder + публичный DTO.
// =============================================================================
const D = new Date('2026-01-01T00:00:00Z');

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'o1', number: 'GA-2026-000001', status: 'new',
    items_total: '100.00', discount_total: '0.00', delivery_total: '500.00',
    grand_total: '600.00', currency: 'RUB', payment_method: 'card',
    payment_status: 'pending', paid_at: null, payment_ref: null, payment_provider: null,
    delivery_type: 'courier', delivery_status: 'pending',
    delivery_city: 'Москва', delivery_address: 'ул. 1', delivery_pvz_code: null,
    delivery_cost: '500.00', cdek_uuid: null, cdek_track: null,
    promo_code_id: null, promo_code: null, gift_certificate_id: null,
    gift_discount_total: '0.00', customer_id: null, customer_name: 'A',
    customer_email: 'a@b.c', customer_phone: '+70000000000', comment: '',
    idempotency_key: null, source: 'storefront', ip: null,
    created_at: D, updated_at: D, ...over,
  };
}

describe('mapOrder / DTO — зона доставки в заказе', () => {
  it('мапит delivery_zone_id и delivery_zone_label', () => {
    const o = mapOrder(row({ delivery_zone_id: 'zone_in', delivery_zone_label: 'В пределах МКАД' }));
    expect(o.deliveryZoneId).toBe('zone_in');
    expect(o.deliveryZoneLabel).toBe('В пределах МКАД');
  });

  it('288 старых заказов: колонок нет / NULL → null, маппинг не падает', () => {
    expect(mapOrder(row()).deliveryZoneId).toBeNull();
    expect(mapOrder(row()).deliveryZoneLabel).toBeNull();
    const o = mapOrder(row({ delivery_zone_id: null, delivery_zone_label: null }));
    expect(o.deliveryZoneId).toBeNull();
    expect(o.deliveryZoneLabel).toBeNull();
  });

  it('toOrderPublicDto пробрасывает зону наружу (и переживает NULL)', () => {
    const dto = toOrderPublicDto(
      mapOrder(row({ delivery_zone_id: 'zone_in', delivery_zone_label: 'В пределах МКАД' })),
      [],
    );
    expect(dto.delivery.zoneId).toBe('zone_in');
    expect(dto.delivery.zoneLabel).toBe('В пределах МКАД');
    const bare = toOrderPublicDto(mapOrder(row()), []);
    expect(bare.delivery.zoneId).toBeNull();
    expect(bare.delivery.zoneLabel).toBeNull();
  });
});

// =============================================================================
// (г) Guard-тесты по исходникам.
// =============================================================================
describe('guard: repository.ts — запись зоны в заказ (anti-tamper)', () => {
  const repo = src('lib/orders/repository.ts');
  const insert = repo.slice(
    repo.indexOf('INSERT INTO orders ('),
    repo.indexOf('INSERT INTO order_items ('),
  );

  it('INSERT INTO orders содержит обе новые колонки', () => {
    expect(insert).toContain('delivery_zone_id');
    expect(insert).toContain('delivery_zone_label');
  });

  it('label берётся из зоны НАСТРОЕК, а не из тела запроса покупателя', () => {
    expect(insert).toMatch(/appliedZone\?\.label/);
    expect(insert).toMatch(/appliedZone\?\.id/);
    // Антипаттерн: подпись/цена зоны из input.delivery — подделываемо покупателем.
    expect(insert).not.toMatch(/input\.delivery\??\.zoneLabel/);
    expect(insert).not.toMatch(/input\.delivery\??\.zonePrice/);
    // Записываемая зона выведена из НАСТРОЕК магазина (строгий резолв по eff.delivery.zones).
    expect(repo).toMatch(
      /deliveryZone = resolveDeliveryZoneStrict\(\{[\s\S]{0,200}zones: eff\.delivery\.zones[\s\S]{0,600}const appliedZone =[\s\S]{0,160}deliveryZone;/,
    );
  });

  it('схема запроса не принимает подпись зоны (только id)', () => {
    const schemas = src('lib/orders/schemas.ts');
    expect(schemas).toContain('zoneId');
    expect(schemas).not.toContain('zoneLabel');
  });

  it('createOrder разрешает зону СТРОГО и отдаёт доменный код invalid_zone', () => {
    expect(repo).toContain('resolveDeliveryZoneStrict');
    expect(repo).toContain("'invalid_zone'");
    expect(repo).toContain('UnknownDeliveryZoneError');
  });

  it('quoteCart считает порог через resolveZonePricing (неизвестная зона → не бесплатно)', () => {
    expect(repo).toContain('resolveZonePricing');
  });
});

describe('guard: storefront CheckoutForm — зональный режим требует адрес', () => {
  const form = src('storefront/app/[lang]/cart/order/CheckoutForm.tsx');

  it("buildDelivery для 'zone' кладёт address (иначе CreateOrderSchema даёт 400)", () => {
    const zoneBranch = form.slice(
      form.indexOf("if (deliveryChoice === 'zone') {"),
      form.indexOf("if (deliveryChoice === 'pvz') {"),
    );
    expect(zoneBranch).toContain('zoneId');
    expect(zoneBranch).toMatch(/address:\s*address\.trim\(\)/);
  });

  it('поле адреса рендерится и в зональном режиме', () => {
    // Антипаттерн: рендер адреса ТОЛЬКО для 'courier'.
    expect(form).not.toMatch(/\{deliveryChoice === 'courier' && \(\s*<label className="sf-field">/);
    expect(form).toMatch(/deliveryChoice === 'zone' \|\| deliveryChoice === 'courier'/);
  });

  it('готовность к отправке в зональном режиме требует непустой адрес', () => {
    const ready = form.slice(
      form.indexOf('const deliveryReady = useMemo'),
      form.indexOf('// ---- Пересчёт'),
    );
    expect(ready).toMatch(/deliveryChoice === 'zone'[\s\S]{0,80}address\.trim\(\)/);
    // Антипаттерн: зона считается готовой лишь по выбранной зоне.
    expect(ready).not.toMatch(/if \(deliveryChoice === 'zone'\) return Boolean\(zoneId\);/);
  });
});

describe('guard: миграция 0053 — аддитивна и идемпотентна', () => {
  const mig = src('db/migrations/0053_orders_delivery_zone.sql');
  // DDL без `--`-комментариев (в комментариях слова DROP/RENAME легитимны —
  // так же их игнорирует scripts/check-migrations.sh).
  const ddl = mig
    .split('\n')
    .map((l) => (l.includes('--') ? l.slice(0, l.indexOf('--')) : l))
    .join('\n');

  it('только ADD COLUMN IF NOT EXISTS, без DROP/RENAME/смены типа', () => {
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS delivery_zone_id');
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS delivery_zone_label');
    expect(ddl).not.toMatch(/\bDROP\b/i);
    expect(ddl).not.toMatch(/\bRENAME\b/i);
    expect(ddl).not.toMatch(/ALTER COLUMN[\s\S]{0,40}TYPE/i);
  });

  it('сид настроек идемпотентен: ON CONFLICT DO NOTHING + UPDATE под защитой', () => {
    expect(ddl).toMatch(/ON CONFLICT \(setting_key\) DO NOTHING/);
    expect(ddl).toMatch(/NOT \(value \? 'zones'\)/);
    expect(ddl).toMatch(/schema_migrations[\s\S]*ON CONFLICT DO NOTHING/);
    // Антипаттерн: безусловный UPDATE затёр бы зоны, заведённые владельцем.
    expect(ddl).not.toMatch(/UPDATE shop_settings[\s\S]{0,200}setting_key = 'delivery';/);
  });

  it('мультитенантность: дефолтные зоны ПУСТЫ (никакого МКАД в коде платформы)', () => {
    expect(ddl).toContain('"zones":[]');
    expect(mig).not.toMatch(/МКАД|MKAD/i);
  });
});
