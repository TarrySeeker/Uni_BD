import { describe, it, expect } from 'vitest';
import {
  STATUS_TO_CATEGORY,
  STATUS_TO_NAME,
  categorize,
  categoryToDeliveryStatus,
  mapCdekStatus,
  displayName,
  clientEmailTemplate,
  adminEmailTemplate,
} from '@/lib/cdek/services/status-map';
import { DELIVERY_STATUS_TRANSITIONS } from '@/lib/orders/status';
import type { DeliveryStatus } from '@/lib/orders/types';

/**
 * Полная матрица маппинга кодов статусов СДЭК → delivery_status заказа Admik
 * (docs/08 §2.4). StatusMap — чистый, без сети/БД → всегда зелёный.
 *
 * Категории carre (1–5) коллапсируют в DeliveryStatus Admik:
 *   1 → registered, 2/3 → in_transit, 4 → delivered, 5 → returned|cancelled.
 */

// Ожидаемая матрица код → DeliveryStatus (порт carre StatusMap.php).
const EXPECTED: Record<string, DeliveryStatus> = {
  // Категория 1 → registered
  CREATED: 'registered',
  ACCEPTED: 'registered',
  // Категория 2 → in_transit
  RECEIVED_AT_SHIPMENT_WAREHOUSE: 'in_transit',
  READY_TO_SHIP_AT_SENDING_OFFICE: 'in_transit',
  TAKEN_BY_TRANSPORTER_FROM_SENDER_CITY: 'in_transit',
  SENT_TO_TRANSIT_CITY: 'in_transit',
  ACCEPTED_IN_TRANSIT_CITY: 'in_transit',
  ACCEPTED_AT_TRANSIT_WAREHOUSE: 'in_transit',
  RETURNED_TO_TRANSIT_WAREHOUSE: 'in_transit',
  READY_TO_SHIP_IN_TRANSIT_OFFICE: 'in_transit',
  TAKEN_BY_TRANSPORTER_FROM_TRANSIT_CITY: 'in_transit',
  SENT_TO_SENDER_CITY: 'in_transit',
  SENT_TO_RECIPIENT_CITY: 'in_transit',
  ON_THE_WAY: 'in_transit',
  // Категория 3 (прибыл в город/ПВЗ) → in_transit
  ACCEPTED_IN_RECIPIENT_CITY: 'in_transit',
  ACCEPTED_AT_PICK_UP_POINT: 'in_transit',
  TAKEN_BY_COURIER: 'in_transit',
  RETURNED_TO_RECIPIENT_CITY_WAREHOUSE: 'in_transit',
  READY_FOR_PICKUP: 'in_transit',
  // Категория 4 → delivered
  DELIVERED: 'delivered',
  // Категория 5 (проблема/возврат) → returned
  NOT_DELIVERED: 'returned',
  RETURNED_TO_SENDER: 'returned',
  RETURNED_TO_SENDER_ACCEPTED: 'returned',
  RETURNED_TO_SENDER_CITY_WAREHOUSE: 'returned',
  INVALID: 'returned',
  LOST: 'returned',
  // Категория 5 (отмена) → cancelled
  CANCELLED: 'cancelled',
};

describe('cdek/status-map — полная матрица кодов → delivery_status', () => {
  for (const [code, expected] of Object.entries(EXPECTED)) {
    it(`${code} → ${expected}`, () => {
      expect(mapCdekStatus(code)).toBe(expected);
    });
  }

  it('покрывает все коды из таблицы STATUS_TO_CATEGORY', () => {
    const codes = Object.keys(STATUS_TO_CATEGORY);
    for (const code of codes) {
      // у каждого известного кода есть детерминированный DeliveryStatus
      expect(mapCdekStatus(code)).not.toBeNull();
    }
    // тестовая матрица охватывает все коды таблицы
    expect(Object.keys(EXPECTED).sort()).toEqual(codes.sort());
  });

  it('каждый результат — валидный DeliveryStatus статус-машины доставки', () => {
    const valid = Object.keys(DELIVERY_STATUS_TRANSITIONS);
    for (const code of Object.keys(EXPECTED)) {
      const ds = mapCdekStatus(code);
      expect(ds === null || valid.includes(ds)).toBe(true);
    }
  });
});

describe('cdek/status-map — неизвестные коды и дефолт', () => {
  it('неизвестный код → null (дефолт; вызывающий пропускает переход)', () => {
    expect(mapCdekStatus('NOPE_NOT_A_CODE')).toBeNull();
    expect(mapCdekStatus('')).toBeNull();
  });

  it('categorize неизвестного кода → 0', () => {
    expect(categorize('NOPE')).toBe(0);
    expect(categorize('CREATED')).toBe(1);
    expect(categorize('DELIVERED')).toBe(4);
  });

  it('категория 0 не имеет delivery_status (нет накладной)', () => {
    expect(categoryToDeliveryStatus(0)).toBeNull();
  });
});

describe('cdek/status-map — категория → delivery_status', () => {
  it('маппинг категорий 1–5', () => {
    expect(categoryToDeliveryStatus(1)).toBe('registered');
    expect(categoryToDeliveryStatus(2)).toBe('in_transit');
    expect(categoryToDeliveryStatus(3)).toBe('in_transit');
    expect(categoryToDeliveryStatus(4)).toBe('delivered');
    // 5 без кода трактуется как returned по умолчанию (проблема)
    expect(categoryToDeliveryStatus(5)).toBe('returned');
  });

  it('CANCELLED — единственный код категории 5 → cancelled (не returned)', () => {
    expect(categorize('CANCELLED')).toBe(5);
    expect(mapCdekStatus('CANCELLED')).toBe('cancelled');
  });
});

describe('cdek/status-map — displayName и шаблоны писем', () => {
  it('displayName известного кода — русское имя', () => {
    expect(displayName('DELIVERED')).toBe('Вручён');
    expect(displayName('CREATED')).toBe('Заказ создан');
    expect(Object.keys(STATUS_TO_NAME)).toContain('DELIVERED');
  });

  it('displayName неизвестного кода — сам код', () => {
    expect(displayName('WEIRD')).toBe('WEIRD');
  });

  it('clientEmailTemplate — шаблон или null', () => {
    expect(clientEmailTemplate('DELIVERED')).toBe('cdek_delivered');
    expect(clientEmailTemplate('READY_FOR_PICKUP')).toBe('cdek_ready_for_pickup');
    expect(clientEmailTemplate('TAKEN_BY_COURIER')).toBe('cdek_courier_dispatched');
    // CREATED — технический, без письма
    expect(clientEmailTemplate('CREATED')).toBeNull();
    expect(clientEmailTemplate('NOPE')).toBeNull();
  });

  it('adminEmailTemplate — cdek_problem для проблемных кодов', () => {
    expect(adminEmailTemplate('NOT_DELIVERED')).toBe('cdek_problem');
    expect(adminEmailTemplate('LOST')).toBe('cdek_problem');
    expect(adminEmailTemplate('CANCELLED')).toBe('cdek_problem');
    expect(adminEmailTemplate('DELIVERED')).toBeNull();
    expect(adminEmailTemplate('NOPE')).toBeNull();
  });
});
