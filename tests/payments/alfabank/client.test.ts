import { describe, it, expect, vi } from 'vitest';
import { AlfabankClient } from '@/lib/payments/alfabank/client';
import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { AlfabankError } from '@/lib/payments/alfabank/errors';

/**
 * Юнит-тесты HTTP-клиента Альфа-Банка (RBS). fetch инъецируется (vi.fn) — без сети.
 * Проверяем userName/password в form-параметрах, amount в копейках, разбор ответов,
 * бизнес-ошибку errorCode, ретрай 5xx.
 */

const CFG = getAlfabankConfig({
  NODE_ENV: 'test',
  ALFABANK_GATEWAY: 'https://alfa.rbsuat.com',
  ALFABANK_USERNAME: 'merchant',
  ALFABANK_PASSWORD: 's3cret',
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('alfabank/client — registerOrder', () => {
  it('POST register.do с userName/password/amount(копейки) → orderId/formUrl', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonRes({ orderId: 'md-778899', formUrl: 'https://alfa.rbsuat.com/payment/merchants/pay?mdOrder=md-778899' }),
    );
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.registerOrder({
      orderNumber: 'ADMIK-2026-000042',
      amountKop: 150000,
      returnUrl: 'https://shop.example/thanks',
      description: 'Заказ ADMIK-2026-000042',
    });
    expect(res).toEqual({
      orderId: 'md-778899',
      formUrl: 'https://alfa.rbsuat.com/payment/merchants/pay?mdOrder=md-778899',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://alfa.rbsuat.com/payment/rest/register.do');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams((init as RequestInit).body as string);
    expect(form.get('userName')).toBe('merchant');
    expect(form.get('password')).toBe('s3cret');
    expect(form.get('orderNumber')).toBe('ADMIK-2026-000042');
    expect(form.get('amount')).toBe('150000'); // КОПЕЙКИ
    expect(form.get('returnUrl')).toBe('https://shop.example/thanks');
  });

  it('бизнес-ошибка errorCode != 0 → AlfabankError', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ errorCode: '5', errorMessage: 'Доступ запрещён' }));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.registerOrder({ orderNumber: 'o', amountKop: 100, returnUrl: 'https://x/ok' }),
    ).rejects.toMatchObject({ alfabankErrorCode: '5' });
  });

  it('нет orderId/formUrl → AlfabankError', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ orderId: 'x' }));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.registerOrder({ orderNumber: 'o', amountKop: 100, returnUrl: 'https://x/ok' }),
    ).rejects.toBeInstanceOf(AlfabankError);
  });
});

describe('alfabank/client — getOrderStatus', () => {
  it('POST getOrderStatusExtended.do → числовой orderStatus', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ orderStatus: 2 }));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.getOrderStatus('md-778899');
    expect(res.orderStatus).toBe(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://alfa.rbsuat.com/payment/rest/getOrderStatusExtended.do',
    );
    const form = new URLSearchParams((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(form.get('orderId')).toBe('md-778899');
  });

  it('нет orderStatus → null', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.getOrderStatus('x')).orderStatus).toBeNull();
  });
});

describe('alfabank/client — refund', () => {
  it('POST refund.do с amount(копейки) → errorCode', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ errorCode: '0' }));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.refund('md-778899', 150000);
    expect(res.errorCode).toBe('0');
    const form = new URLSearchParams((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(form.get('orderId')).toBe('md-778899');
    expect(form.get('amount')).toBe('150000');
  });
});

describe('alfabank/client — ретраи/ошибки', () => {
  it('5xx ретраится и затем успех', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 503 }) : jsonRes({ orderStatus: 2 });
    });
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.getOrderStatus('x', { maxNetworkRetries: 2 });
    expect(res.orderStatus).toBe(2);
    expect(calls).toBe(2);
  });

  it('4xx → AlfabankError с httpStatus', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const client = new AlfabankClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getOrderStatus('x')).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('нет боевых ключей → конструктор кидает AlfabankError', () => {
    const mockCfg = getAlfabankConfig({ NODE_ENV: 'test' });
    expect(() => new AlfabankClient({ config: mockCfg })).toThrow(AlfabankError);
  });
});
