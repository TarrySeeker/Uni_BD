import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD-тесты вёрстки/проводки выхода из тупиков заказа (аудит #8, #9).
 * Тестов React-компонентов в проекте нет (environment: 'node') — проверяем
 * ИСХОДНИКИ чтением файлов, как остальные guard-тесты админки.
 *
 * Смысл: сервер может уметь чинить заказ, но если кнопки нет в карточке —
 * тупик для менеджера остаётся. Здесь фиксируется, что путь дошёл до UI.
 */

const ROOT = join(__dirname, '../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const ORDER_PAGE = 'app/admin/(panel)/orders/[id]/page.tsx';
const CONTACT_FORM = 'app/admin/(panel)/orders/[id]/_components/OrderContactForm.tsx';
const ACTIONS_PANEL = 'app/admin/(panel)/orders/_components/OrderActionsPanel.tsx';
const ORDER_ACTIONS = 'app/admin/(panel)/orders/_components/order-actions.ts';

describe('C1 — форма правки контактов заказа доведена до карточки', () => {
  it('серверная обёртка экспортирует updateOrderContactAction', () => {
    const src = read(ORDER_ACTIONS);
    expect(src).toContain('updateOrderContactAction');
    expect(src).toContain('updateOrderContact');
  });

  it('форма — клиентский компонент и зовёт именно эту обёртку', () => {
    const src = read(CONTACT_FORM);
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain('updateOrderContactAction');
    expect(src).toContain('customerPhone');
    expect(src).toContain('deliveryAddress');
  });

  it('карточка заказа рендерит форму только при праве orders.write', () => {
    const src = read(ORDER_PAGE);
    expect(src).toContain('OrderContactForm');
    expect(src).toMatch(/canWrite\s*\?[\s\S]{0,400}OrderContactForm/);
  });

  it('карточка предупреждает, что телефон не примет накладная СДЭК', () => {
    const src = read(ORDER_PAGE);
    expect(src).toContain('isRussianPhone');
    expect(src).toContain('orders.detailPage.customer.phoneNotCdek');
  });
});

describe('C2 — отгрузка без списания остатка доступна из панели статусов', () => {
  it('панель распознаёт commit_failed и предлагает форс-отгрузку', () => {
    const src = read(ACTIONS_PANEL);
    expect(src).toContain('commit_failed');
    expect(src).toContain('forceStockCommit');
    expect(src).toContain('orders.orderActionsPanel.forceTitle');
  });

  it('форс требует подтверждения и комментария-обоснования', () => {
    const src = read(ACTIONS_PANEL);
    expect(src).toContain('orders.orderActionsPanel.confirmForce');
    expect(src).toContain('orders.orderActionsPanel.forceCommentRequired');
  });
});

describe('i18n — новые ключи есть во всех трёх каталогах', () => {
  const KEYS = [
    'orders.orderContactForm.heading',
    'orders.orderContactForm.intro',
    'orders.orderContactForm.phone',
    'orders.orderContactForm.reason',
    'orders.orderContactForm.submit',
    'orders.orderContactForm.success',
    'orders.orderContactForm.cdekShipmentWarning',
    'orders.orderContactForm.deliveryCostNotice',
    'orders.detailPage.customer.phoneNotCdek',
    'orders.orderActionsPanel.forceTitle',
    'orders.orderActionsPanel.forceHint',
    'orders.orderActionsPanel.forceButton',
    'orders.orderActionsPanel.forceCommentRequired',
    'orders.orderActionsPanel.confirmForce',
  ];

  function value(catalog: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, part) => {
      if (acc !== null && typeof acc === 'object') {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, catalog);
  }

  for (const locale of ['ru', 'en', 'fr'] as const) {
    it(`messages/${locale}.json содержит все ключи непустыми строками`, () => {
      const catalog = JSON.parse(read(`messages/${locale}.json`)) as Record<string, unknown>;
      for (const key of KEYS) {
        const v = value(catalog, key);
        expect(typeof v, `${locale}: ${key}`).toBe('string');
        expect(String(v).trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    });
  }
});
