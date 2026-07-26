import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  type OrderStatus,
  type PaymentStatus,
} from '@/lib/orders/types';
import { isOrderPayable, paymentBlockFor, type PaymentBlock } from '@/lib/orders/status';
import {
  STOREFRONT_ERROR_REASONS,
  reasonForPaymentBlock,
  transportForReason,
} from '@/lib/storefront/error-reasons';

/**
 * 🔴 ДВОЙНАЯ ОПЛАТА (аудит 2026-07-26, третий цикл). Витрина перестала показывать
 * кнопку «оплатить» при холде, но СЕРВЕР по-прежнему принимал инициацию: гард
 * `isOrderPayable` отсекал только paid/refunded, а `authorized` считал
 * оплачиваемым. `authorized` — это УДЕРЖАНИЕ ДЕНЕГ на карте покупателя: вторая
 * инициация = второй счёт по тому же заказу и реальный риск второго списания.
 * Клиентская защита защитой не является — POST на init-эндпоинт шлётся напрямую.
 *
 * Этот файл — СТОРОЖ денежного решения: разбирает ВЕСЬ алфавит `payment_status`
 * (CHECK в db/migrations/0012_orders.sql) × решение об оплачиваемости. Появится
 * шестой статус — тест станет красным ДО выката (и на уровне типов: Record ниже
 * требует все ключи union'а).
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * РЕШЕНИЕ ПО КАЖДОМУ ЗНАЧЕНИЮ АЛФАВИТА (для ЖИВОГО заказа).
 *
 *  pending    — ✅ счёт не оплачен, деньги НЕ удержаны. Это штатный путь оплаты и
 *               путь ретрая «ушёл на шлюз и вернулся ни с чем»: запретить — значит
 *               убить оплату вообще.
 *  authorized — ❌ ХОЛД: деньги уже удержаны на карте, ждём Confirm/вебхука.
 *               Вторая инициация выставит ВТОРОЙ счёт по тому же заказу.
 *  paid       — ❌ деньги получены, платить нечего.
 *  failed     — ✅ попытка не удалась, денег на заказе нет (машина допускает
 *               failed → pending/authorized/paid). Ретрай покупателя легитимен.
 *  refunded   — ❌ деньги возвращены покупателю; заказ на этом закрыт.
 */
const PAYABLE_ON_LIVE_ORDER: Record<PaymentStatus, boolean> = {
  pending: true,
  authorized: false,
  paid: false,
  failed: true,
  refunded: false,
};

/** Доменная причина отказа по каждому НЕоплачиваемому статусу (живой заказ). */
const BLOCK_ON_LIVE_ORDER: Record<PaymentStatus, PaymentBlock | null> = {
  pending: null,
  authorized: 'funds_held',
  paid: 'payment_settled',
  failed: null,
  refunded: 'payment_settled',
};

/** Заказы, по которым платить нельзя ни при каком статусе оплаты. */
const CLOSED_ORDER_STATUSES: OrderStatus[] = ['cancelled', 'refunded'];

describe('алфавит payment_status — источник истины один', () => {
  it('🔴 CHECK в миграции 0012 совпадает с PAYMENT_STATUSES', () => {
    const sql = read('db/migrations/0012_orders.sql');
    const m = /CHECK \(payment_status IN \(([^)]+)\)\)/.exec(sql);
    expect(m, 'CHECK payment_status не найден в 0012_orders.sql').toBeTruthy();
    const fromDb = m![1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(fromDb).toEqual([...PAYMENT_STATUSES].sort());
  });

  it('🔴 решение принято для КАЖДОГО значения алфавита', () => {
    expect(Object.keys(PAYABLE_ON_LIVE_ORDER).sort()).toEqual([...PAYMENT_STATUSES].sort());
    expect(Object.keys(BLOCK_ON_LIVE_ORDER).sort()).toEqual([...PAYMENT_STATUSES].sort());
  });
});

describe('isOrderPayable — полный перебор алфавита × статус заказа', () => {
  for (const orderStatus of ORDER_STATUSES) {
    const closed = CLOSED_ORDER_STATUSES.includes(orderStatus);
    for (const paymentStatus of PAYMENT_STATUSES) {
      const expected = closed ? false : PAYABLE_ON_LIVE_ORDER[paymentStatus];
      it(`order=${orderStatus} payment=${paymentStatus} → ${expected ? 'оплачиваем' : 'НЕ оплачиваем'}`, () => {
        expect(isOrderPayable(orderStatus, paymentStatus)).toBe(expected);
      });
    }
  }

  it('🔴 ХОЛД не оплачивается ни при одном живом статусе заказа (второе списание)', () => {
    for (const orderStatus of ORDER_STATUSES) {
      expect(isOrderPayable(orderStatus, 'authorized'), orderStatus).toBe(false);
    }
  });

  it('ретрай неуспешной оплаты по-прежнему разрешён (не создаём новый тупик)', () => {
    expect(isOrderPayable('new', 'failed')).toBe(true);
    expect(isOrderPayable('awaiting_payment', 'failed')).toBe(true);
    expect(isOrderPayable('paid', 'failed')).toBe(true);
  });
});

describe('paymentBlockFor — доменная причина отказа, а не «просто нельзя»', () => {
  it('закрытый заказ важнее статуса оплаты', () => {
    for (const orderStatus of CLOSED_ORDER_STATUSES) {
      for (const paymentStatus of PAYMENT_STATUSES) {
        expect(paymentBlockFor(orderStatus, paymentStatus), paymentStatus).toBe('order_closed');
      }
    }
  });

  it('живой заказ: причина соответствует статусу оплаты', () => {
    for (const paymentStatus of PAYMENT_STATUSES) {
      expect(paymentBlockFor('awaiting_payment', paymentStatus), paymentStatus).toBe(
        BLOCK_ON_LIVE_ORDER[paymentStatus],
      );
    }
  });

  it('isOrderPayable — это ровно «нет причины отказа» (один источник истины)', () => {
    for (const orderStatus of ORDER_STATUSES) {
      for (const paymentStatus of PAYMENT_STATUSES) {
        expect(isOrderPayable(orderStatus, paymentStatus)).toBe(
          paymentBlockFor(orderStatus, paymentStatus) === null,
        );
      }
    }
  });
});

describe('ответ покупателю — доменная причина, а не общий сбой', () => {
  const blocks: PaymentBlock[] = ['order_closed', 'payment_settled', 'funds_held'];

  it('каждая причина отказа мапится в ПУБЛИЧНЫЙ алфавит витрины', () => {
    for (const block of blocks) {
      const reason = reasonForPaymentBlock(block);
      expect(STOREFRONT_ERROR_REASONS, block).toContain(reason);
      // Конфликт состояния, а не «невалидные данные»: повтор того же запроса
      // не поможет, покупателю нужно другое действие.
      expect(transportForReason(reason), block).toBe('conflict');
    }
  });

  it('🔴 холд отличим от «уже оплачен»: покупателю нужен РАЗНЫЙ текст', () => {
    expect(reasonForPaymentBlock('funds_held')).toBe('payment_in_progress');
    expect(reasonForPaymentBlock('payment_settled')).toBe('order_not_payable');
    expect(reasonForPaymentBlock('order_closed')).toBe('order_not_payable');
  });
});

describe('GUARD: гард стоит на СЕРВЕРЕ, во всех точках инициации оплаты', () => {
  const routes = [
    'app/api/storefront/v1/payments/tbank/init/route.ts',
    'app/api/storefront/v1/payments/paykeeper/init/route.ts',
    'app/api/storefront/v1/payments/alfabank/init/route.ts',
  ];

  it.each(routes)('%s — отказ с доменной причиной по paymentBlockFor', (path) => {
    const src = read(path);
    expect(src).toContain('paymentBlockFor(');
    expect(src).toContain('reasonForPaymentBlock(');
    expect(src).toContain('jsonDomainError(');
  });

  const services = [
    'lib/payments/tbank/service.ts',
    'lib/payments/paykeeper/service.ts',
    'lib/payments/alfabank/service.ts',
  ];

  it.each(services)('%s — второй рубеж: initPayment не выставит счёт без гарда', (path) => {
    const src = read(path);
    expect(src).toContain('isOrderPayable(');
  });
});

/**
 * 🔴 ВЫХОД ИЗ ХОЛДА. Раз `authorized` больше не оплачивается, заказ обязан
 * иметь путь ОБРАТНО в оплачиваемое состояние без участия покупателя — иначе
 * незавершённый холд (истёк, шлюз потерял подтверждение) запирает заказ навсегда.
 * Автоматический путь — крон-сверка: она обязана ВИДЕТЬ такие заказы.
 */
describe('GUARD: незавершённый холд не запирает заказ — его подбирает сверка', () => {
  it('🔴 крон-сверка Т-Банка ищет и pending, и authorized', () => {
    expect(read('lib/payments/tbank/cron.ts')).toContain(
      "payment_status IN ('pending', 'authorized')",
    );
  });

  it('🔴 крон-сверка Альфа-Банка тоже (у RBS двухстадийная оплата = холд)', () => {
    expect(read('lib/payments/alfabank/cron.ts')).toContain(
      "payment_status IN ('pending', 'authorized')",
    );
  });

  it('PayKeeper холда не имеет — там сверять нечего, кроме pending', () => {
    const map = read('lib/payments/paykeeper/status-map.ts');
    expect(map).not.toMatch(/:\s*'authorized'/);
  });
});
