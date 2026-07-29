import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD: витрина инициирует оплату у АКТИВНОГО эквайера, а не у захардкоженного
 * PayKeeper (аудит major №1).
 *
 * ДЕФЕКТ. Единственной инициацией оплаты на витрине был
 * `apiPost('/payments/paykeeper/init')`, поэтому при `PAYMENTS_PROVIDER=tbank`
 * (дефолт!) и пустых ключах PayKeeper покупателя уводило на mock-страницу
 * PayKeeper `/mock/paykeeper/pay`, где кнопка «Оплатить (демо)» помечала заказ
 * оплаченным БЕЗ денег и запускала автовыпуск подарочных сертификатов. Роуты
 * tbank/alfabank из витрины были недостижимы.
 *
 * РЕШЕНИЕ. Витрина ходит в НЕЙТРАЛЬНЫЙ `/payments/init`, а провайдера выбирает
 * сервер. Имя эквайера не утекает ни в публичный DTO настроек, ни в бандл витрины.
 *
 * storefront/ вне корневого tsconfig/eslint и не покрыт React-тестами
 * (environment 'node') — сторожим СУТЬ чтением исходника, как соседние guard-ы.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const API = 'storefront/lib/api.ts';
const TYPES = 'storefront/lib/types.ts';
const CHECKOUT = 'storefront/app/[lang]/cart/order/CheckoutForm.tsx';
const PAY_AGAIN = 'storefront/app/[lang]/cart/success/PayAgain.tsx';

describe('клиент витрины — нейтральный эндпоинт инициации', () => {
  const api = read(API);

  it('🔴 инициация идёт в /payments/init (провайдер выбирает сервер)', () => {
    expect(api).toContain("'/payments/init'");
  });

  it('🔴 захардкоженного пути конкретного эквайера в клиенте НЕТ', () => {
    expect(api, 'витрина не должна знать про PayKeeper').not.toContain(
      '/payments/paykeeper/init',
    );
    expect(api).not.toContain('/payments/tbank/init');
    expect(api).not.toContain('/payments/alfabank/init');
  });

  it('🔴 экспортирована провайдеро-нейтральная функция инициации', () => {
    expect(api).toMatch(/export async function initPayment\s*\(/);
  });
});

describe('типы витрины — DTO инициации не привязан к эквайеру', () => {
  const types = read(TYPES);

  it('🔴 объявлен нейтральный PaymentInitDto с paymentUrl', () => {
    const at = types.indexOf('interface PaymentInitDto');
    expect(at, 'PaymentInitDto не объявлен').toBeGreaterThan(-1);
    expect(types.slice(at, at + 800)).toMatch(/paymentUrl\s*:\s*string/);
  });

  it('никакие секреты/креды эквайера в публичный DTO не приезжают', () => {
    const at = types.indexOf('interface PaymentInitDto');
    const block = types.slice(at, at + 800);
    expect(block).not.toMatch(/secret|password|login|terminalKey/i);
  });
});

describe('места оплаты на витрине — оба через нейтральный вызов', () => {
  it('🔴 чекаут инициирует оплату нейтральной функцией', () => {
    const src = read(CHECKOUT);
    expect(src).toContain('initPayment(');
    expect(src, 'чекаут всё ещё зашит на PayKeeper').not.toContain('initPaykeeperPayment');
  });

  it('🔴 повторная оплата (PayAgain) — тем же нейтральным вызовом', () => {
    const src = read(PAY_AGAIN);
    expect(src).toContain('initPayment(');
    expect(src).not.toContain('initPaykeeperPayment');
    // Периметр доступа не расширен (инвариант payment-retry.guard).
    expect(src).toContain('accessToken');
    expect(src, 'email-путь доступа к оплате чужого заказа').not.toMatch(
      /\bemail\s*[:=]|[?&]email/,
    );
    expect(src, 'повторное создание заказа плодило бы дубликаты').not.toContain('createOrder(');
  });
});

describe('серверная сторона — активный провайдер РЕАЛЬНО используется', () => {
  it('🔴 getActivePaymentProvider вызывается из продакшн-кода, а не только в тестах', () => {
    const route = read('app/api/storefront/v1/payments/init/route.ts');
    expect(route).toContain('getActivePaymentProvider');
  });

  it('legacy-роуты эквайеров сохранены (внешние потребители не сломаны)', () => {
    for (const p of ['paykeeper', 'tbank', 'alfabank']) {
      const src = read(`app/api/storefront/v1/payments/${p}/init/route.ts`);
      expect(src).toMatch(/export async function POST/);
    }
  });
});
