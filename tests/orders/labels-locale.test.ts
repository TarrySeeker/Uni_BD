import { describe, it, expect } from 'vitest';

import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
  ORDER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  DELIVERY_STATUS_LABEL,
  STATUS_LABEL_LOCALES,
} from '@/lib/orders/labels';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_STATUSES,
} from '@/lib/orders/types';

/**
 * Аудит major №5/№28/№30/№35, minor №6: подписи статусов заказа/оплаты/доставки
 * были ЖЁСТКО РУССКИМИ, локаль игнорировалась и покупателем, и оператором.
 *
 * ЯДРО РЕШЕНИЯ. lib/orders/labels остаётся ЕДИНЫМ источником подписей (G-15:
 * расщепление на две карты уже приводило к «Отправлен» на витрине против
 * «Отгружен» в админке). Источник не расщепляется — он получает КОЛОНКИ по
 * локалям, а функции — АДДИТИВНЫЙ необязательный параметр локали.
 *
 * ОБРАТНАЯ СОВМЕСТИМОСТЬ обязательна: старый вызов без локали обязан вернуть тот
 * же русский текст, что и до правки (его печатает живая витрина erfgv.website и
 * пинят существующие тесты tests/admin/order-format, tests/storefront/orders).
 */

const CYRILLIC = /[А-Яа-яЁё]/;

describe('labels — обратная совместимость (вызов без локали)', () => {
  it('без локали подписи ровно те же русские строки, что и до правки', () => {
    // Пины: эти строки печатает живой сайт и ждут существующие тесты.
    expect(orderStatusLabel('new')).toBe('Новый');
    expect(orderStatusLabel('cancelled')).toBe('Отменён');
    expect(orderStatusLabel('shipped')).toBe('Отгружен');
    expect(paymentStatusLabel('paid')).toBe('Оплачена');
    expect(deliveryStatusLabel('in_transit')).toBe('В пути');
  });

  it('явная ru эквивалентна вызову без локали', () => {
    for (const s of ORDER_STATUSES) {
      expect(orderStatusLabel(s, 'ru')).toBe(orderStatusLabel(s));
    }
    for (const s of PAYMENT_STATUSES) {
      expect(paymentStatusLabel(s, 'ru')).toBe(paymentStatusLabel(s));
    }
    for (const s of DELIVERY_STATUSES) {
      expect(deliveryStatusLabel(s, 'ru')).toBe(deliveryStatusLabel(s));
    }
  });

  it('легаси-карты ORDER/PAYMENT/DELIVERY_STATUS_LABEL остались русскими', () => {
    // Их импортируют тесты и потребители — форма и содержание не меняются.
    expect(ORDER_STATUS_LABEL.new).toBe('Новый');
    expect(PAYMENT_STATUS_LABEL.paid).toBe('Оплачена');
    expect(DELIVERY_STATUS_LABEL.in_transit).toBe('В пути');
  });
});

describe('labels — локализация покупателя (major №5, №30, minor №6)', () => {
  it('en/fr переведены: не код и не кириллица — для КАЖДОГО статуса', () => {
    for (const locale of ['en', 'fr'] as const) {
      for (const s of ORDER_STATUSES) {
        const v = orderStatusLabel(s, locale);
        expect(v, `order/${s}/${locale}`).toBeTruthy();
        expect(v, `order/${s}/${locale} — остался кодом`).not.toBe(s);
        expect(CYRILLIC.test(v), `order/${s}/${locale} — кириллица`).toBe(false);
      }
      for (const s of PAYMENT_STATUSES) {
        const v = paymentStatusLabel(s, locale);
        expect(v, `payment/${s}/${locale}`).toBeTruthy();
        expect(v, `payment/${s}/${locale} — остался кодом`).not.toBe(s);
        expect(CYRILLIC.test(v), `payment/${s}/${locale} — кириллица`).toBe(false);
      }
      for (const s of DELIVERY_STATUSES) {
        const v = deliveryStatusLabel(s, locale);
        expect(v, `delivery/${s}/${locale}`).toBeTruthy();
        expect(v, `delivery/${s}/${locale} — остался кодом`).not.toBe(s);
        expect(CYRILLIC.test(v), `delivery/${s}/${locale} — кириллица`).toBe(false);
      }
    }
  });

  it('en/fr — РАЗНЫЕ языки, а не копия друг друга и не копия русского', () => {
    // Guard от «перевели копипастой»: у осмысленного перевода en≠ru и хотя бы
    // часть fr отличается от en.
    for (const s of ORDER_STATUSES) {
      expect(orderStatusLabel(s, 'en')).not.toBe(orderStatusLabel(s, 'ru'));
    }
    const frDiffers = ORDER_STATUSES.filter(
      (s) => orderStatusLabel(s, 'fr') !== orderStatusLabel(s, 'en'),
    );
    expect(frDiffers.length, 'fr — копия en').toBeGreaterThan(4);
  });

  it('конкретные переводы осмысленны', () => {
    expect(orderStatusLabel('new', 'en')).toBe('New');
    expect(orderStatusLabel('shipped', 'en')).toBe('Shipped');
    expect(orderStatusLabel('new', 'fr')).toBe('Nouvelle');
    expect(paymentStatusLabel('paid', 'en')).toBe('Paid');
    expect(deliveryStatusLabel('in_transit', 'en')).toBe('In transit');
    expect(deliveryStatusLabel('in_transit', 'fr')).toBe('En cours de livraison');
  });
});

describe('labels — устойчивость (фолбэки не должны падать)', () => {
  it('незнакомый КОД → сам код в любой локали (как и раньше)', () => {
    for (const locale of STATUS_LABEL_LOCALES) {
      expect(orderStatusLabel('weird', locale)).toBe('weird');
      expect(paymentStatusLabel('xyz', locale)).toBe('xyz');
      expect(deliveryStatusLabel('???', locale)).toBe('???');
    }
  });

  it('незнакомая ЛОКАЛЬ → русская база, а не код и не пустая строка', () => {
    // Магазин может включить 4-й язык раньше, чем появится колонка подписей.
    expect(orderStatusLabel('new', 'de')).toBe('Новый');
    expect(paymentStatusLabel('paid', 'zz-ZZ')).toBe('Оплачена');
    expect(deliveryStatusLabel('in_transit', '')).toBe('В пути');
  });

  it('регистр и региональный суффикс локали не ломают резолв', () => {
    expect(orderStatusLabel('new', 'EN')).toBe('New');
    expect(orderStatusLabel('new', 'en-US')).toBe('New');
    expect(orderStatusLabel('new', 'fr-FR')).toBe('Nouvelle');
  });

  it('покрыты ВСЕ локали платформы, ни одной дыры в картах', () => {
    expect([...STATUS_LABEL_LOCALES]).toEqual(['ru', 'en', 'fr']);
    for (const locale of STATUS_LABEL_LOCALES) {
      for (const s of ORDER_STATUSES) expect(orderStatusLabel(s, locale)).not.toBe(s);
      for (const s of PAYMENT_STATUSES) expect(paymentStatusLabel(s, locale)).not.toBe(s);
      for (const s of DELIVERY_STATUSES) expect(deliveryStatusLabel(s, locale)).not.toBe(s);
    }
  });
});

describe('labels — ключи каталога админки (major №28, №35)', () => {
  /**
   * Оператор смотрит админку на СВОЁМ языке (next-intl, cookie NEXT_LOCALE) —
   * он не обязан совпадать с языком покупателя. Поэтому админке отдаётся КЛЮЧ
   * каталога, а текст выбирает компонент через t(). Это тот же приём, что уже
   * применён к статусам покупателей (customerStatusLabelKey).
   */
  it('для известного кода возвращается ключ каталога orders.statusLabels.*', () => {
    expect(orderStatusLabelKey('new')).toBe('orders.statusLabels.order.new');
    expect(paymentStatusLabelKey('paid')).toBe('orders.statusLabels.payment.paid');
    expect(deliveryStatusLabelKey('in_transit')).toBe(
      'orders.statusLabels.delivery.in_transit',
    );
  });

  it('ключ есть у КАЖДОГО литерала домена', () => {
    for (const s of ORDER_STATUSES) expect(orderStatusLabelKey(s)).toBeTruthy();
    for (const s of PAYMENT_STATUSES) expect(paymentStatusLabelKey(s)).toBeTruthy();
    for (const s of DELIVERY_STATUSES) expect(deliveryStatusLabelKey(s)).toBeTruthy();
  });

  it('незнакомый код → null (страница покажет код, но не соврёт о переводе)', () => {
    expect(orderStatusLabelKey('weird')).toBeNull();
    expect(paymentStatusLabelKey('xyz')).toBeNull();
    expect(deliveryStatusLabelKey('???')).toBeNull();
  });
});
