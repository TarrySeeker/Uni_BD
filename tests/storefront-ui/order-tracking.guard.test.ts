import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { DELIVERY_STATUSES, DELIVERY_TYPES } from '@/lib/orders/types';

import { getDictionary } from '../../storefront/lib/dictionaries';
import { LOCALES, type Locale } from '../../storefront/lib/i18n';
import {
  DELIVERY_STATUS_CODES,
  DELIVERY_METHOD_CODES,
  deliveryStatusText,
  deliveryMethodText,
  deliveryPlaceText,
  orderTrackingPath,
  readOrderLink,
} from '../../storefront/lib/order-view';

/**
 * Находка аудита №5 (КРИТИЧНО): ПОКУПАТЕЛЬ НЕ МОГ УЗНАТЬ, ГДЕ ЕГО ПОСЫЛКА.
 *
 * Факты на момент находки:
 *   • публичный DTO заказа уже отдавал delivery.track и deliveryStatusLabel;
 *   • /cart/success рендерил только статус заказа, оплату и сумму — ни трека,
 *     ни статуса доставки;
 *   • вернуться к заказу позже было НЕКУДА: ни страницы заказа, ни ЛК;
 *   • писем о смене статуса нет (модуля email в платформе нет).
 *
 * Правила, которые здесь сторожатся:
 *   1. на странице заказа видны статус доставки, трек, способ и место доставки;
 *   2. существует постоянная страница заказа по НОМЕРУ + ТОКЕНУ, и ссылка на неё
 *      показана покупателю там, где он её увидит (страница успеха);
 *   3. 🔴 статус доставки переводится ПО КОДУ словарём витрины — иначе рендер
 *      закрепил бы русские серверные подписи для en/fr (отдельная волна).
 *
 * Страницы — React/Next-модули (тестов компонентов в проекте нет, environment
 * 'node'), поэтому вёрстка сторожится чтением исходника, как соседние guard-ы;
 * вся вычислимая логика вынесена в чистый storefront/lib/order-view.ts и
 * проверяется вызовами.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const ORDER_PAGE = 'storefront/app/[lang]/order/page.tsx';
const ORDER_CARD = 'storefront/app/[lang]/components/OrderCard.tsx';
const SUCCESS_PAGE = 'storefront/app/[lang]/cart/success/page.tsx';

/** Заготовка блока delivery публичного DTO. */
function delivery(over: Record<string, unknown> = {}) {
  return {
    type: 'pvz',
    isPostamat: false,
    city: 'Москва',
    zoneId: null,
    zoneLabel: null,
    address: null,
    pvzCode: 'MSK42',
    track: '1106109745',
    ...over,
  } as never;
}

// ---------------------------------------------------------------------------
// 1. Алфавиты витрины совпадают с доменными (иначе перевод молча не найдётся).
// ---------------------------------------------------------------------------

describe('order-view — алфавиты совпадают с платформенными', () => {
  it('коды статусов доставки витрины = DELIVERY_STATUSES домена', () => {
    expect([...DELIVERY_STATUS_CODES].sort()).toEqual([...DELIVERY_STATUSES].sort());
  });

  it('коды способов доставки витрины = DELIVERY_TYPES домена', () => {
    expect([...DELIVERY_METHOD_CODES].sort()).toEqual([...DELIVERY_TYPES].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Перевод статуса доставки ПО КОДУ (не закрепляем русские серверные подписи).
// ---------------------------------------------------------------------------

describe('🔴 deliveryStatusText — статус доставки переводится по коду', () => {
  it('каждый код в каждой локали даёт строку словаря витрины, а не серверную', () => {
    for (const locale of LOCALES) {
      const t = getDictionary(locale).order;
      for (const code of DELIVERY_STATUS_CODES) {
        const text = deliveryStatusText(
          { deliveryStatus: code, deliveryStatusLabel: 'СЕРВЕРНАЯ-РУССКАЯ-ПОДПИСЬ' },
          t,
        );
        expect(text, `${locale}/${code}`).not.toBe('СЕРВЕРНАЯ-РУССКАЯ-ПОДПИСЬ');
        expect(text.length, `${locale}/${code}`).toBeGreaterThan(0);
      }
    }
  });

  it('en/fr не содержат кириллицы (иначе француз читает русский статус)', () => {
    for (const locale of ['en', 'fr'] as Locale[]) {
      const t = getDictionary(locale).order;
      for (const code of DELIVERY_STATUS_CODES) {
        expect(
          deliveryStatusText({ deliveryStatus: code, deliveryStatusLabel: 'x' }, t),
          `${locale}/${code}`,
        ).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it('неизвестный код (новый статус старой витрине) → серверная подпись, не сырой код', () => {
    const t = getDictionary('ru').order;
    expect(
      deliveryStatusText({ deliveryStatus: 'teleported', deliveryStatusLabel: 'Телепортирован' }, t),
    ).toBe('Телепортирован');
  });

  it('неизвестный код БЕЗ серверной подписи → нейтральная строка словаря, не сырой код', () => {
    const t = getDictionary('ru').order;
    const text = deliveryStatusText({ deliveryStatus: 'teleported', deliveryStatusLabel: '' }, t);
    expect(text).not.toBe('teleported');
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Способ и место доставки.
// ---------------------------------------------------------------------------

describe('deliveryMethodText / deliveryPlaceText', () => {
  const t = getDictionary('ru').order;

  it('каждый способ доставки имеет подпись во всех локалях', () => {
    for (const locale of LOCALES) {
      const d = getDictionary(locale).order;
      for (const code of DELIVERY_METHOD_CODES) {
        const text = deliveryMethodText(delivery({ type: code }), d);
        expect(text, `${locale}/${code}`).toBeTruthy();
        expect(text, `${locale}/${code}`).not.toBe(code);
      }
    }
  });

  it('постамат отличается от обычного ПВЗ', () => {
    expect(deliveryMethodText(delivery({ type: 'pvz', isPostamat: true }), t)).not.toBe(
      deliveryMethodText(delivery({ type: 'pvz', isPostamat: false }), t),
    );
  });

  it('ПВЗ: место = город + код пункта выдачи', () => {
    const place = deliveryPlaceText(delivery());
    expect(place).toContain('Москва');
    expect(place).toContain('MSK42');
  });

  it('курьер: место = город + адрес (код ПВЗ не показываем)', () => {
    const place = deliveryPlaceText(
      delivery({ type: 'courier', address: 'ул. Тверская, 1', pvzCode: null }),
    );
    expect(place).toContain('ул. Тверская, 1');
  });

  it('нечего показать → null (пустая строка покупателю не рисуется)', () => {
    expect(
      deliveryPlaceText(delivery({ type: 'pickup', city: null, address: null, pvzCode: null })),
    ).toBeNull();
    expect(deliveryPlaceText(delivery({ city: '  ', pvzCode: '' }))).toBeNull();
  });

  it('старый сервер без address/pvzCode (version skew) → падения нет', () => {
    expect(deliveryPlaceText({ type: 'pvz', isPostamat: false, city: 'Казань', track: null } as never)).toBe(
      'Казань',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Постоянная ссылка на заказ: номер + токен, во всех локалях.
// ---------------------------------------------------------------------------

describe('🔴 orderTrackingPath / readOrderLink — вернуться к заказу позже', () => {
  it('ru живёт на корне, en/fr — под префиксом', () => {
    expect(orderTrackingPath('CR-2026-000123', 'tok', 'ru')).toBe(
      '/order?number=CR-2026-000123&token=tok',
    );
    expect(orderTrackingPath('CR-2026-000123', 'tok', 'fr')).toBe(
      '/fr/order?number=CR-2026-000123&token=tok',
    );
  });

  it('номер и токен экранируются (номер магазина может содержать что угодно)', () => {
    const href = orderTrackingPath('CR 2026/1&x', 'a b+c', 'en');
    expect(href).toContain('number=CR%202026%2F1%26x');
    expect(href).toContain('token=a%20b%2Bc');
  });

  it('readOrderLink: оба параметра есть → пара', () => {
    expect(readOrderLink({ number: 'CR-1', token: 'tok' })).toEqual({
      number: 'CR-1',
      token: 'tok',
    });
  });

  it('🔴 readOrderLink: без токена (или пустой) → null — заказ по одному номеру не открыть', () => {
    expect(readOrderLink({ number: 'CR-1' })).toBeNull();
    expect(readOrderLink({ number: 'CR-1', token: '   ' })).toBeNull();
    expect(readOrderLink({ token: 'tok' })).toBeNull();
    expect(readOrderLink({})).toBeNull();
    expect(readOrderLink(undefined)).toBeNull();
  });

  it('readOrderLink обрезает пробелы (ссылка из письма/мессенджера)', () => {
    expect(readOrderLink({ number: ' CR-1 ', token: ' tok ' })).toEqual({
      number: 'CR-1',
      token: 'tok',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Словарь: секция order заполнена во всех трёх локалях.
// ---------------------------------------------------------------------------

describe('словарь витрины — секция order во всех локалях', () => {
  const ruOrder = getDictionary('ru').order;
  const keys = Object.keys(ruOrder) as (keyof typeof ruOrder)[];

  it('секция непустая и содержит ключи трекинга', () => {
    for (const key of ['statusDelivery', 'track', 'noTrackYet', 'linkTitle', 'linkHint']) {
      expect(keys, key).toContain(key);
    }
  });

  it('каждый ключ заполнен во всех локалях', () => {
    for (const locale of LOCALES) {
      const d = getDictionary(locale).order as Record<string, string>;
      for (const key of keys) {
        expect(typeof d[key as string], `${locale}.${String(key)}`).toBe('string');
        expect((d[key as string] ?? '').trim().length, `${locale}.${String(key)}`).toBeGreaterThan(0);
      }
    }
  });

  it('🔴 ru — по-русски, en/fr — без кириллицы (не английская копия ru)', () => {
    const ru = getDictionary('ru').order as Record<string, string>;
    const en = getDictionary('en').order as Record<string, string>;
    const fr = getDictionary('fr').order as Record<string, string>;
    for (const key of keys as string[]) {
      expect(en[key], `en.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      expect(fr[key], `fr.${key}`).not.toMatch(/[А-Яа-яЁё]/);
      expect(en[key], `en.${key} = ru`).not.toBe(ru[key]);
      expect(fr[key], `fr.${key} = en`).not.toBe(en[key]);
    }
  });

  it('🔴 французский — настоящий французский', () => {
    const fr = getDictionary('fr').order;
    expect(fr.track.toLowerCase()).toContain('suivi');
  });

  it('в секции только строки (функции ломают prerender)', () => {
    for (const locale of LOCALES) {
      for (const v of Object.values(getDictionary(locale).order)) {
        expect(typeof v).toBe('string');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Рендер: страница заказа и страница успеха.
// ---------------------------------------------------------------------------

describe('🔴 OrderCard — на странице заказа виден статус доставки и трек', () => {
  const src = read(ORDER_CARD);

  it('рендерит статус доставки через перевод ПО КОДУ, а не серверную подпись', () => {
    expect(src).toContain('t.statusDelivery');
    expect(src).toContain('deliveryStatusText(');
    expect(src, 'серверная русская подпись напрямую в JSX').not.toMatch(
      /\{\s*order\.deliveryStatusLabel\s*\}/,
    );
  });

  it('рендерит трек-номер заказа', () => {
    expect(src).toContain('t.track');
    expect(src).toContain('order.delivery.track');
  });

  it('трека ещё нет → честное объяснение, а не пустая строка', () => {
    expect(src).toContain('t.noTrackYet');
  });

  it('рендерит способ доставки и место (пункт выдачи/адрес)', () => {
    expect(src).toContain('deliveryMethodText(');
    expect(src).toContain('deliveryPlaceText(');
  });

  it('статусы заказа/оплаты и сумма никуда не делись', () => {
    expect(src).toContain('t.statusOrder');
    expect(src).toContain('t.statusPayment');
    expect(src).toContain('t.statusTotal');
  });
});

describe('🔴 /order — постоянная страница заказа по номеру и токену', () => {
  const src = read(ORDER_PAGE);

  it('страница существует и читает number + token из query', () => {
    expect(src).toContain('readOrderLink(');
    expect(src).toContain('getOrder(');
  });

  it('без валидной пары номер+токен заказ НЕ запрашивается', () => {
    // Запрос идёт только по результату readOrderLink (link ? … : null).
    expect(src).toMatch(/link\s*\?\s*await getOrder\(|if \(!link\)/);
  });

  it('страница заказа закрыта от индексации (в URL — токен доступа)', () => {
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it('переиспользует общую карточку заказа (одна правда на две страницы)', () => {
    expect(src).toContain('OrderCard');
  });
});

describe('🔴 /cart/success — покупателю показана ссылка, по которой он вернётся', () => {
  const src = read(SUCCESS_PAGE);

  it('строит постоянную ссылку на заказ', () => {
    expect(src).toContain('orderTrackingPath(');
  });

  it('ссылка подписана и объяснена (сохраните её)', () => {
    expect(src).toContain('dict.order.linkTitle');
    expect(src).toContain('dict.order.linkHint');
  });

  it('на самой странице успеха тоже виден статус доставки и трек (через OrderCard)', () => {
    expect(src).toContain('OrderCard');
  });
});
