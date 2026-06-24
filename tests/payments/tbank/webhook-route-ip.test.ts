import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SECURITY-тест (волна 4, баг B): IP-whitelist webhook Т-Банка не должен
 * обходиться подделкой клиентских заголовков X-Forwarded-For / X-Real-IP при
 * НЕдоверенном прокси (TBANK_WEBHOOK_TRUST_PROXY=false — дефолт).
 *
 * Прежнее поведение (баг): extractIp при trustProxy=false НЕ возвращал '' рано, а
 * безусловно читал x-real-ip и x-forwarded-for → при дефолтном trustProxy=false
 * непустой TBANK_WEBHOOK_IPS обходился подделкой заголовка. Эталон — СДЭК-порт
 * (там в начале extractIp `if (!trustProxy) return ''`).
 *
 * Фикс: extractIp при trustProxy=false возвращает '' (не читая клиентские
 * заголовки) → подделанный IP не проходит непустой whitelist (ipAllowed→false→403).
 * При trustProxy=true поведение прежнее (валидный XFF → 200).
 *
 * Изоляция: PaymentService.handleWebhook замокан (без БД/сети/Token). Проверяется
 * ИМЕННО IP-гейт route-слоя (до парсинга тела / проверки Token).
 */

const handleWebhookMock = vi.fn(
  async (
    _payload: unknown,
  ): Promise<{ verified: boolean; duplicate: boolean; processed: boolean }> => ({
    verified: true,
    duplicate: false,
    processed: true,
  }),
);

vi.mock('@/lib/payments/tbank/service', () => ({
  PaymentService: class {
    handleWebhook(payload: unknown) {
      return handleWebhookMock(payload);
    }
  },
}));

const ORIG = { ...process.env };

interface PostInit {
  body?: BodyInit;
  headers?: Record<string, string>;
}

async function callPost(init: PostInit = {}) {
  const { POST } = await import('@/app/api/payments/tbank/webhook/route');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(new URL('http://localhost/api/payments/tbank/webhook'), {
    method: 'POST',
    body: init.body,
    headers: init.headers,
  });
  return POST(req);
}

const VALID_IP = '203.0.113.10';

function body(): PostInit {
  return {
    body: JSON.stringify({ TerminalKey: 'tk', PaymentId: '1', Status: 'CONFIRMED', Token: 'x' }),
    headers: { 'content-type': 'application/json' },
  };
}

beforeEach(() => {
  vi.resetModules();
  handleWebhookMock.mockClear();
  handleWebhookMock.mockResolvedValue({ verified: true, duplicate: false, processed: true });
  process.env = { ...ORIG };
  // Боевой контур (на всякий — модуль payments включён по умолчанию).
  delete process.env.ADMIK_MODULES;
  process.env.TBANK_WEBHOOK_IPS = '203.0.113.0/24';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/payments/tbank/webhook — IP-whitelist за доверенным прокси', () => {
  it('trustProxy=true + валидный IP из X-Forwarded-For → 200 (поведение не меняется)', async () => {
    process.env.TBANK_WEBHOOK_TRUST_PROXY = 'true';
    const res = await callPost({
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    expect(handleWebhookMock).toHaveBeenCalledOnce();
  });

  it('trustProxy=true + чужой IP → 403', async () => {
    process.env.TBANK_WEBHOOK_TRUST_PROXY = 'true';
    const res = await callPost({
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/payments/tbank/webhook — подделка IP без trustProxy (security, баг B)', () => {
  it('SECURITY: trustProxy=false (дефолт) + подделка X-Real-IP из whitelist → 403', async () => {
    delete process.env.TBANK_WEBHOOK_TRUST_PROXY; // дефолт false
    const res = await callPost({
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-real-ip': VALID_IP },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookMock).not.toHaveBeenCalled();
  });

  it('SECURITY: trustProxy=false (дефолт) + подделка X-Forwarded-For из whitelist → 403', async () => {
    delete process.env.TBANK_WEBHOOK_TRUST_PROXY;
    const res = await callPost({
      ...body(),
      headers: {
        ...(body().headers as Record<string, string>),
        'x-forwarded-for': `${VALID_IP}, 10.0.0.1`,
      },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookMock).not.toHaveBeenCalled();
  });

  it('SECURITY: TBANK_WEBHOOK_TRUST_PROXY=false явно + подделка X-Real-IP → 403', async () => {
    process.env.TBANK_WEBHOOK_TRUST_PROXY = 'false';
    const res = await callPost({
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-real-ip': VALID_IP },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/payments/tbank/webhook — пустой whitelist (главная защита Token)', () => {
  it('пустой whitelist → IP-гейт пропускает (даже без trustProxy), доходит до Token', async () => {
    delete process.env.TBANK_WEBHOOK_IPS;
    delete process.env.TBANK_WEBHOOK_TRUST_PROXY;
    const res = await callPost({
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-real-ip': VALID_IP },
    });
    // Без IP-ограничения проходит IP-слой → handleWebhook вызван (Token — мок-verified).
    expect(res.status).toBe(200);
    expect(handleWebhookMock).toHaveBeenCalledOnce();
  });
});
