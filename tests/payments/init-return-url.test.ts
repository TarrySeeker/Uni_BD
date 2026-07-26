import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * АДАПТЕРЫ: адрес возврата покупателя доезжает до БОЕВОГО шлюза.
 *
 * Проверяется по одному инварианту на провайдера:
 *   • PayKeeper — форма счёта несёт поле переопределения адреса возврата
 *     (`user_result_callback`), иначе покупатель вернётся на статический адрес из
 *     ЛК, без number/token, и код подарочного сертификата не покажется никогда;
 *   • Т-Банк — Init.SuccessURL берётся из пер-заказного адреса (а не только из
 *     статичного TBANK_SUCCESS_URL);
 *   • Альфа-Банк — register.do.returnUrl берётся из пер-заказного адреса
 *     (приоритет над ALFABANK_RETURN_URL).
 *
 * Сеть не задействована: fetch инъецируется в менеджер (vi.fn), репозиторий заказа
 * замокан.
 */

const setPaymentRefAndProvider = vi.fn(async () => {});
vi.mock('@/lib/payments/paykeeper/repository', () => ({
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProvider(...(a as [])),
  recordWebhookEvent: vi.fn(async () => ({ inserted: true, processed: true })),
  findOrderIdByInvoiceId: vi.fn(async () => null),
  getOrderGrandTotalById: vi.fn(async () => '1500.00'),
}));
vi.mock('@/lib/payments/tbank/repository', () => ({
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProvider(...(a as [])),
  recordWebhookEvent: vi.fn(async () => ({ inserted: true, processed: true })),
}));
vi.mock('@/lib/payments/alfabank/repository', () => ({
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProvider(...(a as [])),
  recordWebhookEvent: vi.fn(async () => ({ inserted: true, processed: true })),
  findOrderIdByPaymentRef: vi.fn(async () => null),
  getOrderGrandTotalById: vi.fn(async () => '1500.00'),
}));
vi.mock('@/lib/orders/repository', () => ({ getOrderByNumber: vi.fn(async () => null) }));

import { PaykeeperManager } from '@/lib/payments/paykeeper/manager';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaymentService as PaykeeperService } from '@/lib/payments/paykeeper/service';
import { TbankManager } from '@/lib/payments/tbank/manager';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import { PaymentService as TbankService } from '@/lib/payments/tbank/service';
import { AlfabankManager } from '@/lib/payments/alfabank/manager';
import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { PaymentService as AlfabankService } from '@/lib/payments/alfabank/service';

const RETURN_URL = 'https://shop.example/en/cart/success?number=ADMIK-2026-000042&token=tok-1';

function fakeOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'order-uuid-1',
    number: 'ADMIK-2026-000042',
    status: 'new',
    grandTotal: '1500.00',
    paymentStatus: 'pending',
    customerEmail: 'buyer@example.com',
    customerPhone: '+79990000000',
    customerName: 'Buyer',
    paymentRef: null,
    ...over,
  };
}

beforeEach(() => setPaymentRefAndProvider.mockClear());

describe('paykeeper — адрес возврата в боевом счёте', () => {
  function liveService(fetchImpl: typeof fetch) {
    const config = getPaykeeperConfig({
      NODE_ENV: 'test',
      PAYKEEPER_BASE_URL: 'https://shop.server.paykeeper.ru',
      PAYKEEPER_LOGIN: 'l',
      PAYKEEPER_PASSWORD: 'p',
    });
    return new PaykeeperService(new PaykeeperManager({ config, fetchImpl }));
  }

  function invoiceFetch(): { fetchImpl: typeof fetch; form: () => URLSearchParams } {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(init ?? {});
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ token: 'tok-xyz' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ invoice_id: '445566', invoice_url: 'https://pay.paykeeper.ru/i/445566' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return {
      fetchImpl,
      form: () =>
        new URLSearchParams(
          (calls.find((c) => c.method === 'POST')?.body as string | undefined) ?? '',
        ),
    };
  }

  it('передаёт user_result_callback с number и token', async () => {
    const { fetchImpl, form } = invoiceFetch();
    await liveService(fetchImpl).initPayment(fakeOrder() as never, [], { returnUrl: RETURN_URL });
    expect(form().get('user_result_callback')).toBe(RETURN_URL);
  });

  it('без адреса возврата поле не отправляется (обратная совместимость)', async () => {
    const { fetchImpl, form } = invoiceFetch();
    await liveService(fetchImpl).initPayment(fakeOrder() as never, []);
    expect(form().has('user_result_callback')).toBe(false);
  });
});

describe('tbank — адрес возврата в Init', () => {
  function liveService(fetchImpl: typeof fetch, over: Record<string, string> = {}) {
    const config = getTbankConfig({
      NODE_ENV: 'test',
      TBANK_TERMINAL_KEY: 'term',
      TBANK_PASSWORD: 'pass',
      ...over,
    });
    return new TbankService(new TbankManager({ config, fetchImpl }));
  }

  function initFetch(): { fetchImpl: typeof fetch; body: () => Record<string, unknown> } {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      sent = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          Success: true,
          PaymentId: '900001',
          PaymentURL: 'https://securepay.tinkoff.ru/x',
          Status: 'NEW',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, body: () => sent };
  }

  it('SuccessURL = пер-заказный адрес возврата (перекрывает TBANK_SUCCESS_URL)', async () => {
    const { fetchImpl, body } = initFetch();
    await liveService(fetchImpl, { TBANK_SUCCESS_URL: 'https://shop.example/static' }).initPayment(
      fakeOrder() as never,
      [],
      { returnUrl: RETURN_URL },
    );
    expect(body().SuccessURL).toBe(RETURN_URL);
  });

  it('без адреса возврата остаётся статический TBANK_SUCCESS_URL', async () => {
    const { fetchImpl, body } = initFetch();
    await liveService(fetchImpl, { TBANK_SUCCESS_URL: 'https://shop.example/static' }).initPayment(
      fakeOrder() as never,
      [],
    );
    expect(body().SuccessURL).toBe('https://shop.example/static');
  });
});

describe('alfabank — адрес возврата в register.do', () => {
  function liveService(fetchImpl: typeof fetch, over: Record<string, string> = {}) {
    const config = getAlfabankConfig({
      NODE_ENV: 'test',
      ALFABANK_USERNAME: 'u',
      ALFABANK_PASSWORD: 'p',
      ...over,
    });
    return new AlfabankService(new AlfabankManager({ config, fetchImpl }));
  }

  it('returnUrl пер-заказный перекрывает ALFABANK_RETURN_URL', async () => {
    let sent = new URLSearchParams();
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      sent = new URLSearchParams((init?.body as string) ?? '');
      return new Response(
        JSON.stringify({ orderId: 'af-1', formUrl: 'https://alfa.rbsuat.com/x' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    await liveService(fetchImpl, { ALFABANK_RETURN_URL: 'https://shop.example/static' }).initPayment(
      fakeOrder() as never,
      [],
      { returnUrl: RETURN_URL },
    );
    expect(sent.get('returnUrl')).toBe(RETURN_URL);
  });
});
