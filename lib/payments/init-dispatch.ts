/**
 * Мультипровайдерный ДИСПЕТЧЕР ИНИЦИАЦИИ ОПЛАТЫ (зеркало refund-диспетчера
 * `lib/payments/dispatch.ts`, docs/24 §2, ADR-P1-3).
 *
 * ПРОБЛЕМА (аудит major №1, деньги). `getActivePaymentProvider()` был объявлен, но
 * НЕ вызывался нигде в продакшн-коде: витрина имела ЕДИНСТВЕННУЮ инициацию оплаты —
 * жёстко в `/payments/paykeeper/init`. При дефолтном `PAYMENTS_PROVIDER=tbank` и
 * пустых `PAYKEEPER_LOGIN/PASSWORD` покупателя уводило на MOCK-страницу PayKeeper
 * `/mock/paykeeper/pay`, где кнопка «Оплатить (демо)» помечала заказ оплаченным БЕЗ
 * денег и запускала автовыпуск подарочных сертификатов. Роуты tbank/alfabank из
 * витрины были недостижимы.
 *
 * РЕШЕНИЕ: тонкий exhaustive switch по АКТИВНОМУ провайдеру магазина. Витрина
 * больше не знает про эквайеров вовсе (ходит в нейтральный `/payments/init`), а имя
 * эквайера не утекает в публичный DTO настроек.
 *
 * ЕДИНАЯ ФОРМА ОТВЕТА. Три адаптера возвращают почти одинаковый результат
 * (`paymentUrl`/`status`/`isMock`) и различаются лишь ключом идентификатора счёта:
 * PayKeeper — `invoiceId`, Т-Банк/Альфа — `paymentId`. Диспетчер нормализует его в
 * `paymentId` и ДОПОЛНИТЕЛЬНО сохраняет `invoiceId` для PayKeeper — чтобы форма
 * ответа старого роута `/payments/paykeeper/init` не поменялась ни на байт.
 *
 * ОФЛАЙН/НЕИЗВЕСТНЫЙ ПРОВАЙДЕР. `manual` (офлайн-магазин: наличные/перевод) и любое
 * НЕ-известное значение → `PaymentInitUnavailableError`. НЕ дефолтим в tbank и НЕ
 * уводим покупателя на mock-страницу чужого эквайера: инициировать оплату нечем, и
 * молчаливая подмена шлюза — это либо деньги в чужой шлюз, либо «оплата» без денег.
 *
 * Тонкий слой: НЕ трогает статусы заказа (это делает сам адаптер/сетл), НЕ дублирует
 * anti-tamper (сумму считает адаптер из `orders.grand_total`, ADR-010) и НЕ решает,
 * можно ли платить (`paymentBlockFor` проверяет вызывающий роут).
 */

import { PaymentService as TbankPaymentService } from '@/lib/payments/tbank/service';
import { PaymentService as PaykeeperPaymentService } from '@/lib/payments/paykeeper/service';
import { PaymentService as AlfabankPaymentService } from '@/lib/payments/alfabank/service';
import {
  isOnlinePaymentProvider,
  type OnlinePaymentProvider,
  type PaymentProvider,
} from '@/lib/payments/provider';
import type { Order, OrderItem } from '@/lib/orders/types';

/** Опции инициации (единый контракт `initPayment` всех трёх адаптеров). */
export interface InitDispatchOptions {
  /** Origin для абсолютной ссылки на demo-страницу оплаты (только mock-ветка). */
  baseOrigin?: string;
  /** Доверенный адрес возврата покупателя со шлюза (уже отрезолвленный). */
  returnUrl?: string;
}

/** Нормализованный результат инициации — единая форма для всех эквайеров. */
export interface InitDispatchResult {
  /** Провайдер, который реально выставил счёт (полезно для диагностики/логов). */
  provider: OnlinePaymentProvider;
  /** Куда редиректить покупателя (invoice_url / PaymentURL / formUrl). */
  paymentUrl: string;
  /** Идентификатор счёта у эквайера (нормализованный: invoiceId → paymentId). */
  paymentId: string;
  /** Сырой статус эквайера после инициации. */
  status: string;
  /** true → mock-режим (ключи эквайера не заданы), денег не будет. */
  isMock: boolean;
  /**
   * Провайдер-специфичный алиас `paymentId` для PayKeeper. Существует РОВНО для
   * обратной совместимости формы ответа `/payments/paykeeper/init`.
   */
  invoiceId?: string;
}

/**
 * Инициация оплаты невозможна: у активного провайдера нет онлайн-шлюза (`manual`)
 * либо значение неизвестно (мисконфигурация). Отдельный класс — чтобы роут отличил
 * «нечем платить» (доменный отказ `payments_disabled`) от «шлюз отказал»
 * (`payment_init_failed`).
 */
export class PaymentInitUnavailableError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'PaymentInitUnavailableError';
    this.provider = provider;
  }
}

/** Compile-time exhaustiveness: новый OnlinePaymentProvider без case → ошибка типов. */
function assertNever(x: never): never {
  throw new PaymentInitUnavailableError(
    String(x),
    `Инициация оплаты не поддержана для провайдера: ${String(x)}.`,
  );
}

/**
 * Маршрутизирует инициацию оплаты в АКТИВНЫЙ эквайер магазина.
 *
 * Бросает `PaymentInitUnavailableError` для `manual`/неизвестного провайдера —
 * безопасно, БЕЗ дефолта в tbank и без ухода на mock чужого шлюза.
 * Ошибки самого шлюза пробрасываются как есть (их обрабатывает вызывающий роут).
 */
export async function dispatchInitPayment(
  provider: PaymentProvider,
  order: Order,
  items: OrderItem[],
  options: InitDispatchOptions = {},
): Promise<InitDispatchResult> {
  // `manual` и любое неизвестное значение: онлайн-инициации НЕТ. Не угадываем чужой
  // шлюз (деньги) и не подсовываем mock-страницу — честный отказ вызывающему.
  if (!isOnlinePaymentProvider(provider)) {
    throw new PaymentInitUnavailableError(
      String(provider),
      `Активный платёжный провайдер «${String(provider)}» не поддерживает онлайн-инициацию ` +
        'оплаты. Инициация отклонена во избежание обращения к неверному платёжному шлюзу.',
    );
  }

  switch (provider) {
    case 'tbank': {
      const res = await new TbankPaymentService().initPayment(order, items, options);
      return {
        provider,
        paymentUrl: res.paymentUrl,
        paymentId: res.paymentId,
        status: res.status,
        isMock: res.isMock,
      };
    }
    case 'paykeeper': {
      const res = await new PaykeeperPaymentService().initPayment(order, items, options);
      return {
        provider,
        paymentUrl: res.paymentUrl,
        // Нормализация ключа + алиас: форма ответа legacy-роута не меняется.
        paymentId: res.invoiceId,
        invoiceId: res.invoiceId,
        status: res.status,
        isMock: res.isMock,
      };
    }
    case 'alfabank': {
      const res = await new AlfabankPaymentService().initPayment(order, items, options);
      return {
        provider,
        paymentUrl: res.paymentUrl,
        paymentId: res.paymentId,
        status: res.status,
        isMock: res.isMock,
      };
    }
    default:
      return assertNever(provider);
  }
}
