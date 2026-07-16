import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тесты роута колбэка Альфа-Банка (callbackUrl) GET/POST /api/payments/alfabank/callback.
 *
 * Server-to-server: query-параметры (GET) + опц. form (POST), без CORS. Порядок:
 *   module-gate 404 → IP-whitelist → parseCallback → handleCallback (checksum, если
 *   секрет задан) → 200 на верифицированном (в т.ч. дубликат); невалидный checksum →
 *   400; модуль выключен → 404; неожиданная ошибка → 500.
 *
 * Изоляция: isModuleEffectivelyEnabled и PaymentService.handleCallback замоканы
 * (parseCallback — РЕАЛЬНЫЙ, чтобы проверить парсинг query-полей).
 */

const moduleEnabled = { value: true };
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: vi.fn(async () => moduleEnabled.value),
}));

const handleCallbackMock = vi.fn();
vi.mock('@/lib/payments/alfabank/service', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    PaymentService: class {
      handleCallback = handleCallbackMock;
    },
  };
});

import { POST, GET } from '@/app/api/payments/alfabank/callback/route';

const VALID_QUERY = {
  mdOrder: 'alfa-778899',
  orderNumber: 'ADMIK-2026-000042',
  operation: 'deposited',
  status: '1',
  checksum: 'ABC123',
};

function queryGet(fields: Record<string, string>): Request {
  const qs = new URLSearchParams(fields).toString();
  return new Request(`http://x/api/payments/alfabank/callback?${qs}`, { method: 'GET' });
}

beforeEach(() => {
  moduleEnabled.value = true;
  handleCallbackMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('alfabank/callback route', () => {
  it('верифицировано (deposited) → 200 ok', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: true,
      processed: true,
      duplicate: false,
      paymentStatus: 'paid',
    });
    const res = await GET(queryGet(VALID_QUERY) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('query-поля распарсены в AlfabankCallbackParams (сырые строки)', async () => {
    handleCallbackMock.mockResolvedValue({ verified: true, processed: true, duplicate: false, paymentStatus: 'paid' });
    await GET(queryGet(VALID_QUERY) as never);
    const [params] = handleCallbackMock.mock.calls[0]!;
    expect(params).toMatchObject({
      mdOrder: 'alfa-778899',
      orderNumber: 'ADMIK-2026-000042',
      operation: 'deposited',
      status: '1',
      checksum: 'ABC123',
    });
  });

  it('невалидный checksum (verified:false) → 400', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: false,
      processed: false,
      duplicate: false,
      paymentStatus: null,
    });
    const res = await GET(queryGet(VALID_QUERY) as never);
    expect(res.status).toBe(400);
  });

  it('ДУБЛИКАТ (verified:true, duplicate:true) → 200 (Альфа не ретраит)', async () => {
    handleCallbackMock.mockResolvedValue({
      verified: true,
      processed: false,
      duplicate: true,
      paymentStatus: null,
    });
    const res = await GET(queryGet(VALID_QUERY) as never);
    expect(res.status).toBe(200);
  });

  it('модуль payments выключен → 404, handleCallback НЕ вызван', async () => {
    moduleEnabled.value = false;
    const res = await GET(queryGet(VALID_QUERY) as never);
    expect(res.status).toBe(404);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('неожиданная ошибка обработки → 500 (Альфа ретрайнет)', async () => {
    handleCallbackMock.mockRejectedValue(new Error('db down'));
    const res = await GET(queryGet(VALID_QUERY) as never);
    expect(res.status).toBe(500);
  });

  it('POST-form вариант тоже обрабатывается', async () => {
    handleCallbackMock.mockResolvedValue({ verified: true, processed: true, duplicate: false, paymentStatus: 'paid' });
    const body = new URLSearchParams(VALID_QUERY).toString();
    const req = new Request('http://x/api/payments/alfabank/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const [params] = handleCallbackMock.mock.calls[0]!;
    expect(params).toMatchObject({ mdOrder: 'alfa-778899', operation: 'deposited' });
  });

  it('GET без параметров при включённом модуле → 200 health', async () => {
    const res = await GET(
      new Request('http://x/api/payments/alfabank/callback', { method: 'GET' }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; service?: string };
    expect(json.service).toBe('alfabank-callback');
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('GET-health при выключенном модуле → 404', async () => {
    moduleEnabled.value = false;
    const res = await GET(
      new Request('http://x/api/payments/alfabank/callback', { method: 'GET' }) as never,
    );
    expect(res.status).toBe(404);
  });
});
