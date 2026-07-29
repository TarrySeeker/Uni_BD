import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD рабочих экранов оператора (аудит: major №25, №26, minor №7, №8).
 *
 * Тестов React-компонентов в проекте нет (environment: 'node'), поэтому вёрстку и
 * проводку сторожим по исходнику — тот же приём, что в refund-ui.guard.test.ts.
 * Сторожим ПРИЧИНЫ аварий, а не разметку:
 *   №26 — время на соседних экранах шло в РАЗНЫХ поясах (аудит жёстко в Москве,
 *         список/карточка — в поясе контейнера, обычно UTC), а фильтр по датам
 *         резал по UTC-суткам и терял ночные заказы;
 *   №25 — из журнала аудита нельзя было попасть в заказ (обрезанный uuid без ссылки,
 *         а поиск в списке заказов по uuid не ищет);
 *   №7  — после конфликта статусов экран не обновлялся: те же кнопки, та же ошибка;
 *   №8  — offset считался до знания total: страница за пределами выборки была пуста
 *         и подписана «заказов пока нет», хотя заказы есть.
 */

const root = (p: string) => join(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/**
 * Исходник БЕЗ комментариев: гарды ищут исчезнувшие конструкции («в коде больше
 * нет X»), а объясняющий комментарий обязан цитировать снятый антипаттерн — иначе
 * следующий читатель не поймёт, от чего его сторожат. Вырезаем комментарии, чтобы
 * цитата в описании не считалась за живой код.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const AUDIT_PAGE = read('app/admin/(panel)/audit/page.tsx');
const ORDERS_PAGE = read('app/admin/(panel)/orders/page.tsx');
const ORDER_FORMAT = read('lib/admin/order-format.ts');
const PANEL = read('app/admin/(panel)/orders/_components/OrderActionsPanel.tsx');
const ORDER_ACTIONS = read('lib/orders/actions.ts');

// Те же файлы без комментариев — для проверок «конструкции БОЛЬШЕ НЕТ».
const AUDIT_CODE = code('app/admin/(panel)/audit/page.tsx');
const ORDERS_CODE = code('app/admin/(panel)/orders/page.tsx');
const ORDER_ACTIONS_CODE = code('lib/orders/actions.ts');

describe('guard №26: один часовой пояс на все экраны оператора', () => {
  it('журнал аудита БОЛЬШЕ не хардкодит Москву', () => {
    expect(
      AUDIT_CODE,
      "'Europe/Moscow' захардкожен в журнале аудита — мультитенантность сломана",
    ).not.toContain("'Europe/Moscow'");
  });

  it('журнал аудита берёт пояс из настройки магазина', () => {
    expect(AUDIT_PAGE).toContain('getShopTimeZone');
  });

  it('список заказов берёт пояс из настройки магазина', () => {
    expect(ORDERS_PAGE).toContain('getShopTimeZone');
  });

  it('форматтер времени принимает пояс явным аргументом (а не берёт пояс контейнера)', () => {
    expect(ORDER_FORMAT).toContain('timeZone');
    expect(
      ORDER_FORMAT,
      'toLocaleString снова без timeZone — время поедет в поясе контейнера',
    ).toMatch(/toLocaleString\([^)]*timeZone/s);
  });

  it('фильтр дат в списке заказов НЕ клеит UTC-сутки строкой', () => {
    expect(
      ORDERS_CODE,
      'сутки снова считаются в UTC — ночные заказы магазина потеряются',
    ).not.toContain('T00:00:00.000Z');
    expect(ORDERS_CODE).not.toContain('T23:59:59.999Z');
    expect(ORDERS_PAGE).toContain('utcDayRangeForShopDay');
  });

  it('верхняя граница периода стала ЭКСКЛЮЗИВНОЙ (< начало следующих суток)', () => {
    expect(ORDERS_PAGE).toMatch(/created_at <\s*\$\{dateTo\}/);
  });
});

describe('guard №25: из журнала аудита можно попасть в сущность', () => {
  it('строка журнала рисует ссылку на сущность', () => {
    expect(AUDIT_PAGE).toContain('entityHref');
  });

  it('заказ резолвится в человекочитаемый номер, а не только в обрезанный uuid', () => {
    expect(AUDIT_PAGE).toContain("collect('order')");
    expect(AUDIT_PAGE).toMatch(/FROM orders WHERE id = ANY/);
  });

  it('🔴 RBAC: ссылка на заказ рисуется ТОЛЬКО при праве orders.read', () => {
    expect(AUDIT_PAGE).toContain("can(user, 'orders.read')");
  });

  it('ссылка ведёт в карточку заказа админки', () => {
    expect(AUDIT_PAGE).toContain('/admin/orders/');
  });
});

describe('guard №7: конфликт статусов не запирает оператора', () => {
  it('после ЛЮБОГО исхода действия страница перечитывается', () => {
    // router.refresh() обязан вызываться и в ветке ошибки — иначе на экране
    // остаются кнопки уже неактуального статуса и каждый клик повторяет ошибку.
    const refreshes = PANEL.match(/router\.refresh\(\)/g) ?? [];
    expect(
      refreshes.length,
      'router.refresh() вызывается только в одной ветке — после конфликта выхода нет, кроме F5',
    ).toBeGreaterThanOrEqual(2);
  });

  it('на конфликт панель показывает подсказку «данные обновлены»', () => {
    expect(PANEL).toContain("result.code === 'conflict'");
    expect(PANEL).toContain('orders.orderActionsPanel.conflictHint');
  });

  it('сообщения конфликта — ключи каталога, а не сырые русские литералы', () => {
    expect(
      ORDER_ACTIONS_CODE,
      'сообщение конфликта снова русский литерал — оператор на en/fr его не прочитает',
    ).not.toContain('изменился параллельно');
    expect(ORDER_ACTIONS).toContain('errors.orders.conflictOrderStatus');
    expect(ORDER_ACTIONS).toContain('errors.orders.conflictPaymentStatus');
    expect(ORDER_ACTIONS).toContain('errors.orders.conflictDeliveryStatus');
  });

  it('в подпись конфликта уезжает КЛЮЧ подписи статуса из общей карты, а не служебный код', () => {
    // Карты подписей не дублируются: используется lib/orders/labels (G-15).
    expect(ORDER_ACTIONS).toContain('conflictParams');
    expect(ORDER_ACTIONS).toMatch(/orderStatusLabelKey|paymentStatusLabelKey|deliveryStatusLabelKey/);
  });
});

describe('guard №8: список заказов клампит страницу до загрузки', () => {
  it('offset больше не считается из сырого filter.page', () => {
    expect(
      ORDERS_CODE,
      'offset снова считается до знания total — страница за пределами выборки будет пуста',
    ).not.toContain('(filter.page - 1) * PAGE_SIZE');
  });

  it('loadOrders возвращает уже склампленную страницу (как в журнале аудита)', () => {
    expect(ORDERS_PAGE).toContain('currentPage');
    expect(ORDERS_PAGE).toMatch(/Math\.min\(\s*filter\.page,\s*totalPages\s*\)/);
  });
});
