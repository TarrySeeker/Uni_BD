import { describe, it, expect } from 'vitest';

import {
  PAYMENT_OUTCOMES,
  PAYMENT_STATUSES,
  SETTLING_WINDOW_MS,
  SUCCESS_TEXT_KEY,
  SUCCESS_TITLE_KEY,
  readGatewayHint,
  resolvePaymentResult,
  type GatewayHint,
  type PaymentOutcome,
} from '../../storefront/lib/payment-result';
import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';
import { PAYMENT_STATUS_TRANSITIONS } from '@/lib/orders/status';

/**
 * ТУПИК ОТМЕНЁННОЙ ОПЛАТЫ (аудит 2026-07-26, находка №1).
 *
 * ФАКТЫ, из которых выведены правила ниже:
 *   • корзина очищается ДО ухода на шлюз (CheckoutForm), заказ уже создан
 *     (status='new', payment_status='pending') — вернуться «в корзину» покупателю
 *     физически некуда;
 *   • mock-шлюз возвращает на страницу успеха один из трёх наборов параметров:
 *     `?paid=1` (успех), `?payment=cancelled` (кнопка «Отмена»),
 *     `?payment=failed` (подтверждение не прошло) — app/mock/{paykeeper,tbank}/pay;
 *     боевой PayKeeper возвращает по настройкам ЛК и наших параметров НЕ несёт;
 *   • страница успеха не читала эти параметры вовсе и печатала «Спасибо! Ваш
 *     заказ принят» с «Оплата: Ожидает» — одинаково для оплаты, отмены и отказа
 *     банка. Кнопки «оплатить» не было.
 *
 * Отсюда: источник истины — СТАТУС ЗАКАЗА из GET /orders/:number, а параметр
 * шлюза лишь уточняет ещё не подтверждённое состояние. Логика чистая (витрина
 * не покрыта React-тестами, environment 'node'), поэтому её место — отдельный
 * модуль storefront/lib/payment-result.ts.
 */

const LOCALES: Locale[] = ['ru', 'en', 'fr'];

function view(over: Partial<Parameters<typeof resolvePaymentResult>[0]> = {}) {
  return resolvePaymentResult({
    paymentStatus: 'pending',
    status: 'new',
    grandTotal: '1500.00',
    hint: null,
    ...over,
  });
}

describe('readGatewayHint — что реально приходит в query от шлюза', () => {
  it('«Отмена» на шлюзе → cancelled', () => {
    expect(readGatewayHint({ payment: 'cancelled' })).toBe('cancelled');
  });

  it('неуспешное подтверждение → failed', () => {
    expect(readGatewayHint({ payment: 'failed' })).toBe('failed');
  });

  it('успешная demo-оплата (?paid=1) → paid', () => {
    expect(readGatewayHint({ paid: '1' })).toBe('paid');
  });

  it('боевой возврат без наших параметров → подсказки нет', () => {
    expect(readGatewayHint({})).toBeNull();
    expect(readGatewayHint({ payment: 'что-угодно' })).toBeNull();
    expect(readGatewayHint({ paid: '0' })).toBeNull();
  });
});

describe('resolvePaymentResult — три состояния оплаты РАЗЛИЧИМЫ', () => {
  it('оплачен → paid, платить повторно нечего', () => {
    expect(view({ paymentStatus: 'paid', hint: 'paid' })).toEqual({
      outcome: 'paid',
      canRetry: false,
    });
  });

  it('🔴 отмена на шлюзе → cancelled, и покупателю дают оплатить', () => {
    expect(view({ hint: 'cancelled' })).toEqual({ outcome: 'cancelled', canRetry: true });
  });

  it('🔴 банк отказал → failed, и покупателю дают оплатить', () => {
    expect(view({ hint: 'failed' })).toEqual({ outcome: 'failed', canRetry: true });
  });

  it('payment_status=failed без подсказки шлюза → тоже failed', () => {
    expect(view({ paymentStatus: 'failed' })).toEqual({ outcome: 'failed', canRetry: true });
  });

  it('🔴 закрыл вкладку / боевой возврат без параметров → awaiting, оплата доступна', () => {
    expect(view()).toEqual({ outcome: 'awaiting', canRetry: true });
  });

  it('вернулся с успехом, но вебхук ещё не дошёл → settling, БЕЗ кнопки оплаты', () => {
    // Иначе покупатель заплатил бы дважды, пока подтверждение в пути.
    expect(view({ hint: 'paid' })).toEqual({ outcome: 'settling', canRetry: false });
  });

  it('заказ отменён/возвращён → closed, оплата невозможна', () => {
    expect(view({ status: 'cancelled' })).toEqual({ outcome: 'closed', canRetry: false });
    expect(view({ status: 'refunded' })).toEqual({ outcome: 'closed', canRetry: false });
    expect(view({ paymentStatus: 'refunded' })).toEqual({ outcome: 'closed', canRetry: false });
  });

  it('отменённый заказ важнее факта оплаты (деньги возвращают, платить нельзя)', () => {
    expect(view({ status: 'cancelled', paymentStatus: 'paid' })).toEqual({
      outcome: 'closed',
      canRetry: false,
    });
  });

  it('платить нечего (сумма 0 — полное покрытие сертификатом) → кнопки нет', () => {
    expect(view({ grandTotal: '0.00', hint: 'cancelled' }).canRetry).toBe(false);
  });

  it('🔴 неизвестный статус чужого тенанта не выдаётся за оплату И не зовёт платить', () => {
    // Консервативно: мы НЕ знаем, удержаны ли деньги, — значит не предлагаем платить.
    const r = view({ paymentStatus: 'partially_paid_whatever' });
    expect(r.outcome).not.toBe('paid');
    expect(r.canRetry, 'неизвестный статус не должен вести к повторной оплате').toBe(false);
  });
});

/**
 * 🔴 P1 — ДВОЙНАЯ ОПЛАТА ПРИ ХОЛДЕ (`payment_status='authorized'`).
 *
 * Алфавит payment_status задан платформой в ДВУХ местах, которые обязаны совпадать:
 * CHECK в db/migrations/0012_orders.sql и таблица переходов
 * PAYMENT_STATUS_TRANSITIONS (lib/orders/status.ts) — pending / authorized / paid /
 * failed / refunded. Прежняя реализация знала только 'paid', 'failed', 'refunded' и
 * DEAD_ORDER_STATUSES; 'authorized' проваливался в `awaiting` С КНОПКОЙ «оплатить»,
 * хотя это ХОЛД: деньги уже удержаны на карте, и второе нажатие списывает их второй
 * раз.
 *
 * Правило: разбираем ВЕСЬ алфавит явно, а всё, чего в алфавите нет, трактуем
 * консервативно — «платить не предлагать».
 */
describe('🔴 весь алфавит payment_status разобран явно', () => {
  it('алфавит витрины совпадает с алфавитом платформы (новый статус — красный тест)', () => {
    // Витрина — отдельное приложение и не импортирует серверные модули, поэтому
    // алфавит там свой; ЭТОТ тест — единственный шов, который не даёт им разойтись.
    expect([...PAYMENT_STATUSES].sort()).toEqual(Object.keys(PAYMENT_STATUS_TRANSITIONS).sort());
  });

  it('каждый статус алфавита даёт объявленный исход (никакого «прочего»)', () => {
    for (const paymentStatus of PAYMENT_STATUSES) {
      const r = view({ paymentStatus });
      expect(PAYMENT_OUTCOMES, `статус ${paymentStatus}`).toContain(r.outcome);
    }
  });

  it('🔴 холд authorized — деньги уже удержаны: кнопки «оплатить» НЕТ', () => {
    expect(view({ paymentStatus: 'authorized' })).toEqual({
      outcome: 'settling',
      canRetry: false,
    });
  });

  it('🔴 холд authorized не отменяется даже подсказкой шлюза', () => {
    // «Отмена»/«отказ» в query — это про попытку, а холд уже стоит на карте.
    for (const hint of ['cancelled', 'failed', 'paid'] as const) {
      expect(view({ paymentStatus: 'authorized', hint }).canRetry, hint).toBe(false);
    }
  });

  it('статусы «деньги у нас/удержаны/возвращены» никогда не зовут платить', () => {
    for (const paymentStatus of ['authorized', 'paid', 'refunded'] as const) {
      expect(view({ paymentStatus }).canRetry, paymentStatus).toBe(false);
    }
  });

  it('платить предлагаем только там, где деньги точно не взяты', () => {
    expect(view({ paymentStatus: 'failed' }).canRetry).toBe(true);
    expect(view({ paymentStatus: 'pending' }).canRetry).toBe(true);
  });
});

/**
 * 🔴 P2 — ГОНКА «ОПЛАТИЛ → ВЕРНУЛСЯ РАНЬШЕ КОЛБЭКА».
 *
 * Ветка `settling` раньше срабатывала ТОЛЬКО по `?paid=1`, а этот параметр ставит
 * лишь наш mock (app/mock/paykeeper/pay). Боевой шлюз возвращает по настройкам
 * своего ЛК и наших параметров не несёт: покупатель заплатил, вернулся быстрее
 * вебхука, увидел «ожидает оплаты» и кнопку — и платит второй раз.
 *
 * Сигнал вместо подсказки — ФАКТ с сервера: `orders.payment_initiated_at`
 * (проставляется при выставлении счёта всеми провайдерами) в публичном DTO как
 * `paymentInitiatedAt`. Пока с момента инициации прошло мало времени, кнопки нет.
 * ВЫХОД ИЗ ТУПИКА: окно КОНЕЧНО — если подтверждение так и не пришло, кнопка
 * возвращается сама.
 */
describe('🔴 оплата инициирована, подтверждение ещё не пришло', () => {
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it('минуту назад инициировал, статус pending → кнопки НЕТ, есть проверка статуса', () => {
    expect(
      view({ paymentInitiatedAt: ago(60_000), now: NOW }),
    ).toEqual({ outcome: 'settling', canRetry: false });
  });

  it('🔴 час назад инициировал, статус pending → кнопка ЕСТЬ (не тупик)', () => {
    expect(
      view({ paymentInitiatedAt: ago(60 * 60_000), now: NOW }),
    ).toEqual({ outcome: 'awaiting', canRetry: true });
  });

  it('окно конечно: ровно на границе кнопка уже вернулась', () => {
    expect(view({ paymentInitiatedAt: ago(SETTLING_WINDOW_MS - 1), now: NOW }).canRetry).toBe(false);
    expect(view({ paymentInitiatedAt: ago(SETTLING_WINDOW_MS), now: NOW }).canRetry).toBe(true);
    // Окно осмысленной длины: минуты, а не сутки.
    expect(SETTLING_WINDOW_MS).toBeGreaterThan(60_000);
    expect(SETTLING_WINDOW_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it('оплату не инициировали ни разу → обычное ожидание с кнопкой', () => {
    expect(view({ paymentInitiatedAt: null, now: NOW })).toEqual({
      outcome: 'awaiting',
      canRetry: true,
    });
  });

  it('старый сервер без поля в DTO ведёт себя как раньше (кнопка есть)', () => {
    expect(view({ paymentInitiatedAt: undefined, now: NOW }).canRetry).toBe(true);
  });

  it('мусор вместо времени не блокирует оплату навсегда', () => {
    expect(view({ paymentInitiatedAt: 'позавчера', now: NOW }).canRetry).toBe(true);
  });

  it('перекос часов (время инициации в будущем) трактуется консервативно', () => {
    expect(view({ paymentInitiatedAt: ago(-5 * 60_000), now: NOW }).canRetry).toBe(false);
  });

  it('🔴 устаревшая ссылка ?payment=cancelled из истории браузера НЕ пробивает окно', () => {
    // Покупатель отменил оплату, вернулся, начал платить заново — и открыл СТАРУЮ
    // вкладку/ссылку с `?payment=cancelled`. Подсказка не аутентифицирована и
    // описывает прошлую попытку; серверный факт (счёт выставлен минуту назад)
    // говорит, что платёж идёт прямо сейчас. Кнопка = второе списание.
    expect(view({ paymentInitiatedAt: ago(60_000), now: NOW, hint: 'cancelled' })).toEqual({
      outcome: 'settling',
      canRetry: false,
    });
  });

  it('🔴 подсказка «отказ» при свежей инициации тоже не даёт кнопку', () => {
    expect(view({ paymentInitiatedAt: ago(60_000), now: NOW, hint: 'failed' })).toEqual({
      outcome: 'settling',
      canRetry: false,
    });
  });

  it('🔴 payment_status=failed при свежей инициации — колбэк новой попытки ещё в пути', () => {
    // 'failed' — про ПРЕДЫДУЩУЮ попытку; счёт выставлен минуту назад, значит идёт
    // новая. Это самая частая ветка ретрая, и гонка здесь такая же, как в pending.
    expect(
      view({ paymentStatus: 'failed', paymentInitiatedAt: ago(60_000), now: NOW }),
    ).toEqual({ outcome: 'settling', canRetry: false });
  });

  it('🔴 но окно конечно и для failed: через час кнопка возвращается', () => {
    expect(
      view({ paymentStatus: 'failed', paymentInitiatedAt: ago(60 * 60_000), now: NOW }),
    ).toEqual({ outcome: 'failed', canRetry: true });
  });

  it('окно НЕ воскрешает закрытый заказ и не отменяет факт оплаты', () => {
    expect(view({ paymentInitiatedAt: ago(60_000), now: NOW, status: 'cancelled' })).toEqual({
      outcome: 'closed',
      canRetry: false,
    });
    expect(
      view({ paymentInitiatedAt: ago(60_000), now: NOW, paymentStatus: 'paid' }).outcome,
    ).toBe('paid');
  });

  it('свежая инициация при нулевой сумме кнопку не показывает и после окна', () => {
    expect(view({ grandTotal: '0.00', paymentInitiatedAt: ago(60 * 60_000), now: NOW }).canRetry)
      .toBe(false);
  });
});

/**
 * 🔴 T1/T2 — ДОВЕРИЕ К ДАННЫМ ИЗ АДРЕСНОЙ СТРОКИ.
 *
 * `?payment=cancelled|failed` приходит из QUERY: значение не аутентифицировано,
 * его ставит кто угодно, и оно легко оказывается УСТАРЕВШИМ — покупатель открыл
 * старую вкладку или ссылку из истории браузера, а платёж тем временем прошёл.
 * Прежняя редакция возвращала по такой подсказке `canRetry: true` РАНЬШЕ, чем
 * спрашивала серверный факт (T1), а ветка `payment_status='failed'` не спрашивала
 * его вовсе (T2) — хотя именно failed чаще всего и ретраят, и колбэк новой попытки
 * запросто ещё в пути.
 *
 * ПРАВИЛО: серверный факт важнее подсказки. Подсказка может лишь УТОЧНЯТЬ то, что
 * сервер не опроверг, и никогда — открывать оплату поверх серверного «платёж идёт».
 * Свежая инициация (P2) учитывается во ВСЕХ ветках, где предлагается платить.
 *
 * ВЫХОД ИЗ ТУПИКА тот же: окно конечно (см. последний кейс), а страница говорит об
 * этом словами (`settlingHint`).
 *
 * Проверяем ПЕРЕБОРОМ матрицы «статус × подсказка × свежесть инициации» — точечные
 * кейсы уже дважды пропускали дыру в соседней ветке свитча.
 */
describe('🔴 приоритет: серверный факт выше подсказки из адресной строки', () => {
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');
  const HINTS: GatewayHint[] = [null, 'paid', 'cancelled', 'failed'];

  /** Третья ось матрицы — свежесть `payment_initiated_at`. */
  const FRESHNESS = {
    'счёт не выставляли': null,
    'инициация старая (окно истекло)': new Date(NOW - SETTLING_WINDOW_MS - 1).toISOString(),
    'инициация свежая (минуту назад)': new Date(NOW - 60_000).toISOString(),
  } as const;
  type Freshness = keyof typeof FRESHNESS;
  const FRESH: Freshness = 'инициация свежая (минуту назад)';
  const STALE: Freshness[] = ['счёт не выставляли', 'инициация старая (окно истекло)'];

  const cell = (paymentStatus: string, hint: GatewayHint, freshness: Freshness) =>
    view({ paymentStatus, hint, paymentInitiatedAt: FRESHNESS[freshness], now: NOW });

  it('🔴 свежая инициация закрывает оплату при ЛЮБОМ статусе и ЛЮБОЙ подсказке', () => {
    const statuses = [...PAYMENT_STATUSES, 'статус_из_будущей_версии'];
    for (const paymentStatus of statuses) {
      for (const hint of HINTS) {
        expect(cell(paymentStatus, hint, FRESH).canRetry, `${paymentStatus} + hint=${hint}`).toBe(
          false,
        );
      }
    }
  });

  it('🔴 подсказка НИКОГДА не открывает оплату там, где её не открыл сервер', () => {
    // Формально: canRetry(любая подсказка) ⊆ canRetry(без подсказки) при тех же
    // статусе и свежести. Подсказка вправе только УТОЧНИТЬ причину и только сузить.
    for (const paymentStatus of PAYMENT_STATUSES) {
      for (const freshness of Object.keys(FRESHNESS) as Freshness[]) {
        const server = cell(paymentStatus, null, freshness).canRetry;
        for (const hint of HINTS) {
          if (cell(paymentStatus, hint, freshness).canRetry) {
            expect(server, `${paymentStatus}/${freshness}/hint=${hint}`).toBe(true);
          }
        }
      }
    }
  });

  it('🔴 пока платёж свежий, оба «платимых» статуса показывают ожидание, а не оплату', () => {
    for (const paymentStatus of ['pending', 'failed'] as const) {
      for (const hint of HINTS) {
        expect(cell(paymentStatus, hint, FRESH), `${paymentStatus} + hint=${hint}`).toEqual({
          outcome: 'settling',
          canRetry: false,
        });
      }
    }
  });

  it('🔴 НЕ тупик: окно истекло — оплата снова доступна при любой «неоплатной» подсказке', () => {
    for (const paymentStatus of ['pending', 'failed'] as const) {
      for (const freshness of STALE) {
        for (const hint of [null, 'cancelled', 'failed'] as GatewayHint[]) {
          expect(
            cell(paymentStatus, hint, freshness).canRetry,
            `${paymentStatus}/${freshness}/hint=${hint}`,
          ).toBe(true);
        }
      }
    }
  });

  it('🔴 подсказка уточняет причину там, где сервер её не опроверг', () => {
    // Ожидание закончилось: сервер молчит о деньгах, и текст берётся по подсказке.
    const stale: Freshness = 'счёт не выставляли';
    expect(cell('pending', 'cancelled', stale).outcome).toBe('cancelled');
    expect(cell('pending', 'failed', stale).outcome).toBe('failed');
    expect(cell('pending', null, stale).outcome).toBe('awaiting');
  });

  it('🔴 ожидание объяснено словами во всех трёх локалях (иначе это новый тупик)', () => {
    for (const locale of LOCALES) {
      const dict = getDictionary(locale).success;
      expect(dict[SUCCESS_TEXT_KEY.settling].trim().length, locale).toBeGreaterThan(0);
      expect(dict.settlingHint.trim().length, `${locale}: обещание вернуть кнопку`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('🔴 каждому исходу — СВОЙ заголовок и СВОЙ текст во всех трёх локалях', () => {
  it('исходы покрыты картами заголовка и текста', () => {
    for (const outcome of PAYMENT_OUTCOMES) {
      expect(SUCCESS_TITLE_KEY[outcome], `title для ${outcome}`).toBeTruthy();
      expect(SUCCESS_TEXT_KEY[outcome], `text для ${outcome}`).toBeTruthy();
    }
  });

  it('оплачено / ожидает / отменено — разные заголовки и разные тексты', () => {
    const trio: PaymentOutcome[] = ['paid', 'awaiting', 'cancelled'];
    for (const locale of LOCALES) {
      const dict = getDictionary(locale).success;
      const titles = trio.map((o) => dict[SUCCESS_TITLE_KEY[o]]);
      const texts = trio.map((o) => dict[SUCCESS_TEXT_KEY[o]]);
      expect(new Set(titles).size, `${locale}: заголовки`).toBe(3);
      expect(new Set(texts).size, `${locale}: тексты`).toBe(3);
    }
  });

  it('ни один текст исхода не пуст и не содержит технического кода', () => {
    for (const locale of LOCALES) {
      const dict = getDictionary(locale).success;
      for (const outcome of PAYMENT_OUTCOMES) {
        const title = dict[SUCCESS_TITLE_KEY[outcome]];
        const text = dict[SUCCESS_TEXT_KEY[outcome]];
        expect(title.trim().length, `${locale}/${outcome}`).toBeGreaterThan(0);
        expect(text.trim().length, `${locale}/${outcome}`).toBeGreaterThan(0);
        for (const s of [title, text]) {
          // Ни snake_case-идентификаторов домена (payment_status, order_not_payable),
          // ни HTTP-кодов — покупателю показывают человеческий язык.
          expect(s, `${locale}/${outcome}: технический код в тексте`).not.toMatch(
            /[a-z]+_[a-z]+|HTTP|\b[45]\d\d\b/,
          );
        }
      }
    }
  });

  it('🔴 неоплаченные исходы НЕ поздравляют с оплатой', () => {
    const ru = getDictionary('ru').success;
    for (const outcome of ['cancelled', 'failed', 'closed'] as PaymentOutcome[]) {
      expect(ru[SUCCESS_TEXT_KEY[outcome]], outcome).not.toMatch(/оплачен[оа]?\b/i);
    }
  });

  it('французский — настоящий французский, не английская копия', () => {
    const en = getDictionary('en').success;
    const fr = getDictionary('fr').success;
    for (const outcome of PAYMENT_OUTCOMES) {
      expect(fr[SUCCESS_TEXT_KEY[outcome]], outcome).not.toBe(en[SUCCESS_TEXT_KEY[outcome]]);
    }
    expect(fr.payAgain).not.toBe(en.payAgain);
    expect(fr.payAgain).not.toMatch(/[А-Яа-яЁё]/);
  });
});
