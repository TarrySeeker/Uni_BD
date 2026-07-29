import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
} from '@/lib/orders/labels';
import { ORDER_STATUSES, PAYMENT_STATUSES, DELIVERY_STATUSES } from '@/lib/orders/types';

/**
 * Аудит minor №7 (попутная находка) — сообщение о конкурентной смене статуса.
 *
 * Раньше в тексте стоял СЫРОЙ код: «переход из "awaiting_payment" более
 * неактуален» — служебная строка на языке автора кода. Теперь сообщение это ключ
 * каталога с ICU-параметром {from}, а в параметр уезжает КЛЮЧ подписи статуса из
 * общей карты lib/orders/labels (G-15, вторая карта не заводится); пайплайн
 * Server Action разворачивает вложенный ключ перед форматированием.
 *
 * Тест сторожит целостность цепочки: ключ сообщения есть во всех трёх каталогах,
 * несёт {from}, и КАЖДЫЙ ключ подписи статуса, который может туда приехать,
 * реально существует в каталоге — иначе оператор увидел бы голый ключ.
 */

const LOCALES = ['ru', 'en', 'fr'] as const;

function catalog(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function lookup(cat: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = cat;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, catalog(l)])) as Record<
  (typeof LOCALES)[number],
  Record<string, unknown>
>;

const CONFLICT_KEYS = [
  'errors.orders.conflictOrderStatus',
  'errors.orders.conflictPaymentStatus',
  'errors.orders.conflictDeliveryStatus',
];

describe('конфликт статусов — сообщение локализовано', () => {
  it.each(CONFLICT_KEYS)('ключ %s есть во всех трёх каталогах', (key) => {
    for (const l of LOCALES) {
      expect(lookup(catalogs[l], key), `${key} отсутствует в ${l}`).toBeTruthy();
    }
  });

  it.each(CONFLICT_KEYS)('%s несёт ICU-параметр {from} во всех локалях', (key) => {
    for (const l of LOCALES) {
      expect(lookup(catalogs[l], key)).toContain('{from}');
    }
  });

  it('en/fr — осмысленный перевод, а не копия русского', () => {
    for (const key of CONFLICT_KEYS) {
      const ru = lookup(catalogs.ru, key)!;
      expect(lookup(catalogs.en, key)).not.toBe(ru);
      expect(lookup(catalogs.fr, key)).not.toBe(ru);
      // Гард на кириллицу: перевод не должен быть русским текстом.
      expect(lookup(catalogs.en, key)).not.toMatch(/[А-Яа-яЁё]/);
      expect(lookup(catalogs.fr, key)).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});

describe('конфликт статусов — подстановка {from} резолвится в подпись, а не в код', () => {
  it('ключ подписи КАЖДОГО статуса заказа существует в каталоге', () => {
    for (const status of ORDER_STATUSES) {
      const key = orderStatusLabelKey(status);
      expect(key, `нет ключа подписи для статуса заказа ${status}`).toBeTruthy();
      for (const l of LOCALES) {
        expect(lookup(catalogs[l], key!), `${key} отсутствует в ${l}`).toBeTruthy();
      }
    }
  });

  it('ключ подписи КАЖДОГО статуса оплаты существует в каталоге', () => {
    for (const status of PAYMENT_STATUSES) {
      const key = paymentStatusLabelKey(status);
      expect(key).toBeTruthy();
      for (const l of LOCALES) {
        expect(lookup(catalogs[l], key!), `${key} отсутствует в ${l}`).toBeTruthy();
      }
    }
  });

  it('ключ подписи КАЖДОГО статуса доставки существует в каталоге', () => {
    for (const status of DELIVERY_STATUSES) {
      const key = deliveryStatusLabelKey(status);
      expect(key).toBeTruthy();
      for (const l of LOCALES) {
        expect(lookup(catalogs[l], key!), `${key} отсутствует в ${l}`).toBeTruthy();
      }
    }
  });

  it('незнакомый код НЕ выдумывает ключ (в сообщение уедет сам код — лучше, чем пусто)', () => {
    expect(orderStatusLabelKey('нет_такого')).toBeNull();
    expect(paymentStatusLabelKey('нет_такого')).toBeNull();
    expect(deliveryStatusLabelKey('нет_такого')).toBeNull();
  });
});

describe('пайплайн разворачивает ключи-значения ICU-параметров', () => {
  const ACTION = readFileSync(join(process.cwd(), 'lib/server/action.ts'), 'utf8');

  it('translateMessage прогоняет params через resolveParamKeys', () => {
    expect(ACTION).toContain('resolveParamKeys');
    expect(ACTION).toMatch(/t\(key,\s*resolveParamKeys\(t,\s*params\)\)/);
  });

  it('значение-параметр, которого нет в каталоге, остаётся как есть (email/номер не ломаются)', () => {
    // Контракт зафиксирован в коде: t.has(value) ? t(value) : value.
    expect(ACTION).toMatch(/t\.has\(value\)\s*\?\s*t\(value\)\s*:\s*value/);
  });
});
