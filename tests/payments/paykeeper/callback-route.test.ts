import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тесты роута колбэка PayKeeper POST /api/payments/paykeeper/callback (docs/24 §2).
 *
 * Server-to-server: form-urlencoded (req.formData, НЕ json), без CORS. Порядок:
 *   module-gate 404 → IP-whitelist → parseCallback → handleCallback (подпись —
 *   главная защита) → на верифицированном (в т.ч. дубликат) СТРОГО `OK `+md5(id+secret);
 *   невалидная подпись → 400 (не-OK); модуль выключен → 404.
 *
 * Изоляция: isModuleEffectivelyEnabled и PaymentService.handleCallback замоканы
 * (parseCallback — РЕАЛЬНЫЙ, чтобы проверить парсинг form-полей).
 */

const moduleEnabled = { value: true };
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: vi.fn(async () => moduleEnabled.value),
}));

const handleCallbackMock = vi.fn();
vi.mock('@/lib/payments/paykeeper/service', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    PaymentService: class {
      handleCallback = handleCallbackMock;
    },
  };
});

import { POST, GET } from '@/app/api/payments/paykeeper/callback/route';

function formPost(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request('http://x/api/payments/paykeeper/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

const VALID_FIELDS = {
  id: '778899',
  sum: '1500.00',
  clientid: 'buyer@example.com',
  orderid: 'ADMIK-2026-000042',
  key: 'abc123',
};

beforeEach(() => {
  moduleEnabled.value = true;
  handleCallbackMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('paykeeper/callback route', () => {
  it('валидная подпись → 200, text/plain body = ack `OK `+md5', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: true,
      processed: true,
      duplicate: false,
      paymentStatus: 'paid',
      ack: 'OK deadbeefdeadbeefdeadbeefdeadbeef',
    });
    const res = await POST(formPost(VALID_FIELDS) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('OK deadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('form-поля распарсены в PaykeeperCallbackParams (сырые строки)', async () => {
    handleCallbackMock.mockResolvedValue({ verified: true, ack: 'OK x', duplicate: false, processed: true, paymentStatus: 'paid' });
    await POST(formPost(VALID_FIELDS) as never);
    const [params] = handleCallbackMock.mock.calls[0]!;
    expect(params).toMatchObject({
      id: '778899',
      sum: '1500.00',
      clientid: 'buyer@example.com',
      orderid: 'ADMIK-2026-000042',
      key: 'abc123',
    });
  });

  it('невалидная подпись (verified:false) → 400 не-OK', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: false,
      processed: false,
      duplicate: false,
      paymentStatus: null,
      ack: null,
    });
    const res = await POST(formPost(VALID_FIELDS) as never);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('OK ');
  });

  it('ДУБЛИКАТ (verified:true, duplicate:true) → 200 ack (PayKeeper не должен ретраить)', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: true,
      processed: false,
      duplicate: true,
      paymentStatus: null,
      ack: 'OK cafecafecafecafecafecafecafecafe',
    });
    const res = await POST(formPost(VALID_FIELDS) as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK cafecafecafecafecafecafecafecafe');
  });

  it('модуль payments выключен → 404, handleCallback НЕ вызван', async () => {
    moduleEnabled.value = false;
    const res = await POST(formPost(VALID_FIELDS) as never);
    expect(res.status).toBe(404);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('неожиданная ошибка обработки → 500 (PayKeeper ретрайнет)', async () => {
    handleCallbackMock.mockRejectedValue(new Error('db down'));
    const res = await POST(formPost(VALID_FIELDS) as never);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('OK ');
  });

  it('GET health при включённом модуле → 200 ok', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it('GET при выключенном модуле → 404', async () => {
    moduleEnabled.value = false;
    const res = await GET();
    expect(res.status).toBe(404);
  });
});
