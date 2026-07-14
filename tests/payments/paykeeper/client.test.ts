import { describe, it, expect, vi } from 'vitest';
import { PaykeeperClient } from '@/lib/payments/paykeeper/client';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaykeeperError } from '@/lib/payments/paykeeper/errors';

/**
 * Юнит-тесты HTTP-клиента PayKeeper (docs/24 §2). fetch инъецируется (vi.fn) —
 * без сети. Проверяем Basic-Auth, form-urlencoded тело инвойса, ретрай 5xx.
 */

const CFG = getPaykeeperConfig({
  NODE_ENV: 'test',
  PAYKEEPER_BASE_URL: 'https://shop.server.paykeeper.ru',
  PAYKEEPER_LOGIN: 'shopLogin',
  PAYKEEPER_PASSWORD: 's3cret',
  PAYKEEPER_SERVICE_NAME: 'Sale',
  PAYKEEPER_LANG: 'ru',
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('paykeeper/client — getToken', () => {
  it('GET /info/settings/token/ с Basic-Auth → token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ token: 'tok-123' }));
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const token = await client.getToken();
    expect(token).toBe('tok-123');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://shop.server.paykeeper.ru/info/settings/token/');
    expect((init as RequestInit).method).toBe('GET');
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('shopLogin:s3cret').toString('base64')}`);
  });

  it('нет token в ответе → PaykeeperError', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({}));
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getToken()).rejects.toBeInstanceOf(PaykeeperError);
  });
});

describe('paykeeper/client — createInvoice', () => {
  it('POST form-urlencoded с pay_amount/clientid/orderid/service_name/token → invoice', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonRes({ token: 'tok-xyz' });
      return jsonRes({ invoice_id: '445566', invoice_url: 'https://pay.paykeeper.ru/i/445566' });
    });
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.createInvoice({
      payAmount: '1500.00',
      clientId: 'buyer@example.com',
      orderId: 'ADMIK-2026-000042',
      cart: [{ name: 'Платок', price: '1500.00', quantity: 1, sum: '1500.00', tax: 'vat20' }],
      clientPhone: '+79990000000',
      clientEmail: 'buyer@example.com',
    });
    expect(res).toEqual({ invoiceId: '445566', invoiceUrl: 'https://pay.paykeeper.ru/i/445566' });

    const postCall = fetchImpl.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
    const [url, init] = postCall;
    expect(String(url)).toBe('https://shop.server.paykeeper.ru/change/invoice/preview/');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams((init as RequestInit).body as string);
    expect(form.get('pay_amount')).toBe('1500.00');
    expect(form.get('clientid')).toBe('buyer@example.com');
    expect(form.get('orderid')).toBe('ADMIK-2026-000042');
    expect(form.get('token')).toBe('tok-xyz');
    expect(form.get('client_phone')).toBe('+79990000000');
    expect(form.get('client_email')).toBe('buyer@example.com');
    // service_name — JSON { cart, lang, service_name } (сверено с carre).
    const sn = JSON.parse(form.get('service_name')!);
    expect(sn.service_name).toBe('Sale');
    expect(sn.lang).toBe('ru');
    expect(sn.cart).toHaveLength(1);
    expect(sn.cart[0].name).toBe('Платок');
  });

  it('нет invoice_id в ответе → PaykeeperError', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET' ? jsonRes({ token: 't' }) : jsonRes({ error: 'x' }),
    );
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.createInvoice({ payAmount: '10.00', clientId: 'c', orderId: 'o', cart: [] }),
    ).rejects.toBeInstanceOf(PaykeeperError);
  });
});

describe('paykeeper/client — getInvoiceStatus', () => {
  it('GET /info/invoice/byid/?id= → status', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({ status: 'paid' }));
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.getInvoiceStatus('445566');
    expect(res.status).toBe('paid');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://shop.server.paykeeper.ru/info/invoice/byid/?id=445566',
    );
  });

  it('нет status → null', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonRes({}));
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.getInvoiceStatus('1')).status).toBeNull();
  });
});

describe('paykeeper/client — ретраи/ошибки', () => {
  it('5xx ретраится и затем успех', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 503 }) : jsonRes({ token: 'ok' });
    });
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    const token = await client.getToken({ maxNetworkRetries: 2 });
    expect(token).toBe('ok');
    expect(calls).toBe(2);
  });

  it('4xx → PaykeeperError с httpStatus', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('nope', { status: 401 }));
    const client = new PaykeeperClient({ config: CFG, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getToken()).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('нет боевых ключей → конструктор кидает PaykeeperError', () => {
    const mockCfg = getPaykeeperConfig({ NODE_ENV: 'test' });
    expect(() => new PaykeeperClient({ config: mockCfg })).toThrow(PaykeeperError);
  });
});
