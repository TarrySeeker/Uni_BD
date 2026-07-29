import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD: страница успеха различает исходы оплаты и даёт покупателю ДОПЛАТИТЬ.
 *
 * ДЕФЕКТ (аудит 2026-07-26, находка №1 — тупик отменённой оплаты): корзина
 * очищалась до ухода на шлюз, заказ уже существовал, а страница /cart/success
 * печатала «Спасибо! Ваш заказ принят» одинаково и для оплаты, и для нажатой
 * «Отмены», и для отказа банка. Оплатить созданный заказ было НЕЧЕМ и НЕГДЕ:
 * кнопки нет, страницы «оплатить по номеру» нет, ЛК покупателя на витрине нет.
 *
 * Правила, которые сторожим:
 *   • параметры возврата шлюза (`payment=cancelled|failed`, `paid=1`) читаются;
 *   • заголовок и текст берутся ПО ИСХОДУ (карты чистого модуля), а не печатаются
 *     безусловно;
 *   • при canRetry на странице появляется действие оплаты — по тому же периметру
 *     доступа (number + HMAC-token), что и показ кодов сертификата;
 *   • действие оплаты клиентское, не расширяет периметр (никакого ?email=) и не
 *     показывает покупателю сырой машинный код ошибки.
 *
 * storefront/ вне корневого tsconfig/eslint и не покрыт React-тестами
 * (environment 'node') — сторожим СУТЬ чтением исходника, как соседние guard-ы.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const PAGE = 'storefront/app/[lang]/cart/success/page.tsx';
const BUTTON = 'storefront/app/[lang]/cart/success/PayAgain.tsx';
const LOGIC = 'storefront/lib/payment-result.ts';
const DICT = 'storefront/lib/dictionaries.ts';

describe('страница успеха — исход оплаты читается и различается', () => {
  const page = read(PAGE);

  it('🔴 параметры возврата шлюза объявлены в searchParams и прочитаны', () => {
    const at = page.indexOf('searchParams');
    expect(at).toBeGreaterThan(-1);
    // Типизация searchParams включает оба параметра возврата.
    expect(page).toMatch(/payment\?:\s*string/);
    expect(page).toMatch(/paid\?:\s*string/);
    expect(page).toContain('readGatewayHint(');
  });

  it('🔴 исход считает чистый модуль, а не разметка', () => {
    expect(page).toMatch(/from '@\/lib\/payment-result'/);
    expect(page).toContain('resolvePaymentResult(');
    expect(page).toContain('outcome');
  });

  it('заголовок и текст выбираются ПО ИСХОДУ', () => {
    expect(page).toContain('SUCCESS_TITLE_KEY[');
    expect(page).toContain('SUCCESS_TEXT_KEY[');
    // Безусловного «Спасибо, заказ принят» в ветке известного заказа больше нет:
    // dict.success.thanks остаётся только фолбэком, когда заказ прочитать нельзя.
    expect(page.split('dict.success.thanks').length - 1, 'thanks должен остаться фолбэком').toBe(1);
  });

  /**
   * 🔴 P2: «подтверждение в пути» определяется СЕРВЕРНЫМ ФАКТОМ, а не подсказкой
   * шлюза. `?paid=1` ставит только наш mock — боевой эквайер такого не шлёт.
   */
  it('🔴 в расчёт исхода передаётся время инициации платежа из DTO', () => {
    const at = page.indexOf('resolvePaymentResult(');
    expect(page.slice(at, at + 400)).toMatch(/paymentInitiatedAt:\s*order\.paymentInitiatedAt/);
  });

  it('🔴 пока подтверждение в пути — есть перепроверка статуса И виден выход из ожидания', () => {
    expect(page).toMatch(/outcome === 'settling'/);
    expect(page).toContain('refreshStatus');
    // Обещание «кнопка вернётся» — иначе ожидание выглядит как новый тупик.
    expect(page, 'покупателю не объяснили, что делать, если подтверждение не придёт').toContain(
      'settlingHint',
    );
  });

  it('🔴 при canRetry монтируется действие оплаты с номером и токеном', () => {
    expect(page).toMatch(/import\s+PayAgain\s+from\s+'\.\/PayAgain'/);
    expect(page).toMatch(/canRetry/);
    expect(page).toMatch(/<PayAgain[\s\S]{0,300}number=\{(order\.)?number\}/);
    expect(page).toMatch(/<PayAgain[\s\S]{0,300}token=\{token\}/);
  });
});

describe('постоянная страница заказа — тоже даёт оплатить', () => {
  const page = read('storefront/app/[lang]/order/page.tsx');

  it('🔴 неоплаченный заказ по постоянной ссылке можно оплатить', () => {
    expect(page).toContain('resolvePaymentResult(');
    expect(page).toMatch(/import\s+PayAgain\s+from/);
    expect(page).toMatch(/canRetry/);
  });

  it('подсказки шлюза здесь нет — решает статус заказа', () => {
    const at = page.indexOf('resolvePaymentResult(');
    expect(page.slice(at, at + 400)).toMatch(/hint:\s*null/);
  });

  it('🔴 и здесь свежая инициация платежа прячет кнопку (та же защита от двойной оплаты)', () => {
    const at = page.indexOf('resolvePaymentResult(');
    expect(page.slice(at, at + 400)).toMatch(/paymentInitiatedAt:\s*order\.paymentInitiatedAt/);
  });
});

describe('публичный DTO витрины знает о начатой оплате', () => {
  const types = read('storefront/lib/types.ts');

  it('🔴 поле объявлено в типе заказа (иначе страница не увидит факт)', () => {
    const at = types.indexOf('interface OrderPublicDto');
    expect(at).toBeGreaterThan(-1);
    expect(types.slice(at, at + 1500)).toMatch(/paymentInitiatedAt[?]?:\s*string\s*\|\s*null/);
  });

  it('внутренний id счёта эквайера витрине не отдают', () => {
    const at = types.indexOf('interface OrderPublicDto');
    expect(types.slice(at, at + 1500)).not.toMatch(/paymentRef/);
  });
});

describe('PayAgain — повторная оплата уже созданного заказа', () => {
  const src = read(BUTTON);

  it('компонент клиентский и без серверных импортов', () => {
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec.startsWith('node:')).toBe(false);
      expect(spec).not.toMatch(/next\/headers|server-only|postgres|@\/lib\/db/);
    }
  });

  it('🔴 периметр доступа не расширен: только number + accessToken', () => {
    expect(src).toContain('accessToken');
    // Email — угадываемое значение: как ключ доступа к ИНИЦИАЦИИ ПЛАТЕЖА он
    // расширил бы периметр. Ни в теле запроса, ни в query его быть не должно.
    expect(src, 'email-путь доступа к оплате чужого заказа').not.toMatch(
      /\bemail\s*[:=]|[?&]email/,
    );
  });

  it('оплата инициируется существующим эндпоинтом, новый заказ НЕ создаётся', () => {
    // Эндпоинт стал НЕЙТРАЛЬНЫМ (`/payments/init`): эквайер выбирает сервер по
    // конфигу магазина. Суть инварианта та же — оплата идёт существующей ручкой,
    // а не через повторное создание заказа (аудит major №1).
    expect(src).toContain('initPayment(');
    expect(src, 'повторное создание заказа плодило бы дубликаты').not.toContain('createOrder(');
  });

  it('повторное нажатие не плодит инициаций (кнопка блокируется на время)', () => {
    expect(src).toMatch(/disabled=\{busy\}/);
    expect(src).toMatch(/setBusy\(true\)/);
  });

  it('🔴 сырой код/сообщение ошибки покупателю не показывается', () => {
    expect(src).not.toMatch(/err\.message/);
    expect(src).not.toMatch(/\{\s*error\.(code|reason)\s*\}/);
    // Известная доменная причина — своя строка словаря, остальное — общая.
    expect(src).toContain('order_not_payable');
    expect(src).toContain('payAgainNotPayable');
    expect(src).toContain('payAgainError');
  });

  it('возврат со шлюза ведёт на ту же страницу заказа', () => {
    expect(src).toContain('returnUrl');
    expect(src).toMatch(/window\.location\.origin/);
  });
});

describe('чистый модуль исхода оплаты не тянет ни React, ни сеть', () => {
  const src = read(LOGIC);

  it('без импортов среды', () => {
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec).not.toMatch(/^react|next|node:/);
    }
    expect(src).not.toContain('fetch(');
  });
});

describe('словари витрины — строки исходов оплаты во всех трёх локалях', () => {
  const dict = read(DICT);
  const keys = [
    'titleAwaiting',
    'titleCancelled',
    'titleFailed',
    'titleClosed',
    'textPaid',
    'textSettling',
    'textAwaiting',
    'textCancelled',
    'textFailed',
    'textClosed',
    'payAgain',
    'payAgainBusy',
    'payAgainError',
    'payAgainNotPayable',
    // Холд поймали уже после клика: «деньги удержаны, платить снова не нужно».
    'payAgainInProgress',
    'refreshStatus',
    // Выход из ожидания подтверждения: если вебхук так и не пришёл, оплатить
    // можно будет снова — покупателю это обязаны сказать словами.
    'settlingHint',
  ];

  it('каждый ключ объявлен в интерфейсе и заполнен в ru/en/fr (4 вхождения)', () => {
    for (const key of keys) {
      const count = dict.split(`${key}:`).length - 1;
      expect(count, `${key}: интерфейс + ru/en/fr`).toBe(4);
    }
  });

  it('значения непустые, различны по локалям и без кириллицы в en/fr', () => {
    for (const key of keys) {
      const values = [...dict.matchAll(new RegExp(`\\b${key}:\\s*'([^']+)'`, 'g'))].map(
        (m) => m[1]!,
      );
      expect(values.length, `${key}: три значения`).toBe(3);
      expect(new Set(values).size, `${key}: локали не должны совпадать`).toBe(3);
      expect(values[0], `${key}: ru`).toMatch(/[А-Яа-яЁё]/);
      expect(values[1], `${key}: en`).not.toMatch(/[А-Яа-яЁё]/);
      expect(values[2], `${key}: fr`).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('🔴 в добавленных ключах только строки (функции ломают prerender)', () => {
    for (const key of keys) {
      let from = 0;
      for (;;) {
        const at = dict.indexOf(`${key}:`, from);
        if (at < 0) break;
        expect(dict.slice(at, at + 300)).not.toMatch(/^[^\n]*=>/m);
        from = at + key.length;
      }
    }
  });
});
