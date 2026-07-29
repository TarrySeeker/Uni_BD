import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Аудит major #8: в админ-карточке заказа не видно, что заказ оплачен
 * подарочным сертификатом.
 *
 * Механика бага: блок итогов печатал только items / discountTotal /
 * deliveryTotal / grandTotal. Поле order.giftDiscountTotal (и связка
 * giftCertificateId) в app/admin/ не встречалось ВООБЩЕ, хотя домен его несёт и
 * витрина его уже показывает (lib/storefront/order-dto.ts). Менеджер видел
 * несходящиеся суммы (items − скидка + доставка ≠ итог) и не знал ни кода
 * сертификата, ни списанной суммы.
 *
 * GUARD-тесты вёрстки (React-компоненты в проекте юнитом не рендерятся,
 * environment 'node'): сторожат СУТЬ — нужные данные читаются из домена, строка
 * условная (нет сертификата → нет строки), подписи только через next-intl,
 * ключи есть во всех трёх каталогах.
 */

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const ORDER_PAGE = src('app/admin/(panel)/orders/[id]/page.tsx');

const LOCALES = ['ru', 'en', 'fr'] as const;
const catalogs = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(src(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

function val(locale: (typeof LOCALES)[number], dot: string): string {
  let o: unknown = catalogs[locale];
  for (const k of dot.split('.')) {
    o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  }
  return typeof o === 'string' ? o : '';
}

/** Блок итогов заказа (<dl> с суммами) — вырезаем, чтобы не ловить совпадения из других секций. */
function summaryBlock(): string {
  const start = ORDER_PAGE.indexOf("t('orders.detailPage.summary.items')");
  const end = ORDER_PAGE.indexOf("t('orders.detailPage.summary.grandTotal')");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return ORDER_PAGE.slice(start, end);
}

describe('админ-карточка заказа — списание подарочного сертификата (аудит major #8)', () => {
  it('страница вообще читает списание сертификата из домена заказа', () => {
    // До фикса grep giftDiscountTotal|giftCertificateId по app/admin/ давал НОЛЬ.
    expect(ORDER_PAGE).toContain('order.giftDiscountTotal');
  });

  it('строка списания стоит в блоке итогов, между скидкой и итогом', () => {
    const block = summaryBlock();
    expect(block).toContain('order.giftDiscountTotal');
    // Сумма форматируется как деньги в валюте заказа (домен — рубли-строка
    // NUMERIC(14,2), НЕ копейки: копейки живут только в платежах).
    expect(block).toContain('formatPrice(order.giftDiscountTotal, order.currency)');
  });

  it('строка условная: без сертификата (0.00) её нет — иначе шум в каждом заказе', () => {
    // Условие проверяется на СУММЕ (giftDiscountTotal), а не только на наличии
    // giftCertificateId: домен пишет id лишь при giftApplies, но 0-строка в
    // итогах бесполезна в любом случае.
    expect(ORDER_PAGE).toMatch(/giftDiscount(Applied|Kop|Minor|Num)|Number\(order\.giftDiscountTotal\)|toMinor\(order\.giftDiscountTotal\)/);
  });

  it('код сертификата подтягивается, когда он доступен (giftCertificateId)', () => {
    expect(ORDER_PAGE).toContain('order.giftCertificateId');
    // Код берём из домена сертификатов, а не выдумываем.
    expect(ORDER_PAGE).toContain('getGiftCertificateById');
  });

  it('подписи — только next-intl, без русских литералов в JSX', () => {
    const block = summaryBlock();
    expect(block).toContain("t('orders.detailPage.summary.giftDiscount')");
    // В вырезанном блоке итогов не должно быть кириллических литералов.
    expect(block).not.toMatch(/[А-Яа-яЁё]{3,}/);
  });

  it('ключи подписей есть и непусты во ВСЕХ трёх каталогах (ru/en/fr)', () => {
    for (const key of [
      'orders.detailPage.summary.giftDiscount',
      'orders.detailPage.summary.giftCode',
    ]) {
      for (const l of LOCALES) {
        expect(val(l, key).trim().length, `${l}: ${key}`).toBeGreaterThan(0);
      }
    }
    // ru — по-русски, en/fr — не по-русски (не копипаста русского текста).
    expect(val('ru', 'orders.detailPage.summary.giftDiscount')).toMatch(/[А-Яа-яЁё]/);
    for (const l of ['en', 'fr'] as const) {
      expect(val(l, 'orders.detailPage.summary.giftDiscount')).not.toMatch(/[А-Яа-яЁё]/);
      expect(val(l, 'orders.detailPage.summary.giftCode')).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('чтение сертификата не рушит карточку и не тянется без нужды', () => {
    // Загрузка кода — только при наличии giftCertificateId (иначе лишний запрос
    // на КАЖДОЙ карточке заказа).
    expect(ORDER_PAGE).toMatch(/order\.giftCertificateId\s*(\?|&&|!==\s*null|!=\s*null)/);
  });
});
