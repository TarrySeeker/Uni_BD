import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Интеграционные тесты webhook-роута СДЭК (docs/08 §8, Пакет F).
 *
 * Без живой БД/сети: WebhookService.handleWebhookEvent мокается, проверяется
 * связка route-слоя. Модель защиты (после фикса безопасности):
 *
 *   • СЕКРЕТ ?key= — ПЕРВИЧНАЯ аутентификация. Вне mock-режима (есть боевые
 *     ключи CDEK_ACCOUNT/CDEK_SECRET) запрос обязан предъявить ИЛИ верный ?key=
 *     (если CDEK_WEBHOOK_SECRET задан), ИЛИ пройти IP-whitelist за доверенным
 *     прокси. Если не настроены НИ секрет, НИ whitelist — роут не работает
 *     открытым (401), чтобы исключить запись произвольного статуса в боевые
 *     orders.
 *   • IP-WHITELIST — доп. слой ТОЛЬКО за доверенным прокси
 *     (CDEK_WEBHOOK_TRUST_PROXY=true). Без trustProxy клиент-контролируемые
 *     X-Forwarded-For / X-Real-IP НЕ доверяются как источник IP (docs/08 §8.2:
 *     «IP берём из соединения, не из X-Forwarded-For»). Подделка XFF/X-Real-IP
 *     без trustProxy НЕ даёт обхода.
 *   • Пустой whitelist допускает bypass ТОЛЬКО в mock-режиме (нет боевых
 *     ключей) — edu/CI-контур, а НЕ при CDEK_TEST_MODE с боевыми ключами.
 *   • Парсинг: битый JSON → 200 warn=invalid_json (СДЭК не должен ретраить).
 *   • module-gate: cdek выключен → 404.
 */

const handleWebhookEventMock = vi.fn(
  async (_payload: unknown, _ip?: string): Promise<{ processed: boolean; duplicate: boolean }> => ({
    processed: true,
    duplicate: false,
  }),
);

vi.mock('@/lib/cdek/services/webhook', async (importOriginal) => {
  // verifyWebhookIp/parseEvent — настоящие (чистые); подменяем только класс сервиса.
  const actual = await importOriginal<typeof import('@/lib/cdek/services/webhook')>();
  return {
    ...actual,
    WebhookService: class {
      handleWebhookEvent(payload: unknown, ip?: string) {
        return handleWebhookEventMock(payload, ip);
      }
    },
  };
});

const ORIG = { ...process.env };

interface PostInit {
  body?: BodyInit;
  headers?: Record<string, string>;
}

async function callPost(url: string, init: PostInit = {}) {
  const { POST } = await import('@/app/api/cdek/webhook/route');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(new URL(url), {
    method: 'POST',
    body: init.body,
    headers: init.headers,
  });
  return POST(req);
}

/** Боевой контур: заданы CDEK_ACCOUNT/CDEK_SECRET → isMock=false. */
function setLiveKeys(): void {
  process.env.CDEK_ACCOUNT = 'acc-live';
  process.env.CDEK_SECRET = 'sec-live';
}

beforeEach(() => {
  vi.resetModules();
  handleWebhookEventMock.mockClear();
  handleWebhookEventMock.mockResolvedValue({ processed: true, duplicate: false });
  process.env = { ...ORIG };
  // По умолчанию: боевой контур (исключаем mock-bypass), whitelist + trustProxy
  // активны (IP-слой проверяем за доверенным прокси), без секрета.
  delete process.env.CDEK_TEST_MODE;
  setLiveKeys();
  process.env.CDEK_WEBHOOK_IPS = '203.0.113.0/24';
  process.env.CDEK_WEBHOOK_TRUST_PROXY = 'true';
  delete process.env.CDEK_WEBHOOK_SECRET;
  // Тихо игнорируем warn-шум защиты.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const VALID_IP = '203.0.113.10';
const FOREIGN_IP = '198.51.100.7';

function body(): PostInit {
  return {
    body: JSON.stringify({
      type: 'ORDER_STATUS',
      uuid: 'u-1',
      attributes: { number: 'TC-1', code: 'DELIVERED', status_date_time: '2026-06-15T10:00:00Z' },
    }),
    headers: { 'content-type': 'application/json' },
  };
}

describe('POST /api/cdek/webhook — IP-whitelist за доверенным прокси', () => {
  it('валидный IP из X-Forwarded-For (trustProxy) → 200, событие обработано', async () => {
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; processed: boolean };
    expect(json.ok).toBe(true);
    expect(handleWebhookEventMock).toHaveBeenCalledOnce();
  });

  it('чужой IP (trustProxy) → 403, событие НЕ обрабатывается', async () => {
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': FOREIGN_IP },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/cdek/webhook — подделка заголовков IP без trustProxy (security)', () => {
  it('БЕЗ trustProxy подделка X-Real-IP из whitelist НЕ даёт обхода → 403', async () => {
    // Атака: секрет не задан, whitelist — единственная защита, trustProxy=false.
    process.env.CDEK_WEBHOOK_TRUST_PROXY = 'false';
    delete process.env.CDEK_WEBHOOK_SECRET;
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-real-ip': VALID_IP },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('БЕЗ trustProxy подделка X-Forwarded-For из whitelist НЕ даёт обхода → 403', async () => {
    process.env.CDEK_WEBHOOK_TRUST_PROXY = 'false';
    delete process.env.CDEK_WEBHOOK_SECRET;
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: {
        ...(body().headers as Record<string, string>),
        'x-forwarded-for': `${VALID_IP}, 10.0.0.1`,
      },
    });
    expect(res.status).toBe(403);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('секрет ?key= как первичная аутентификация проходит и без trustProxy', async () => {
    // С верным секретом IP-слой не требуется (секрет — первичная защита).
    process.env.CDEK_WEBHOOK_TRUST_PROXY = 'false';
    process.env.CDEK_WEBHOOK_SECRET = 's3cr3t';
    delete process.env.CDEK_WEBHOOK_IPS;
    const res = await callPost('http://localhost/api/cdek/webhook?key=s3cr3t', body());
    expect(res.status).toBe(200);
    expect(handleWebhookEventMock).toHaveBeenCalledOnce();
  });
});

describe('POST /api/cdek/webhook — секрет ?key= (первичная аутентификация)', () => {
  it('секрет задан, ключ неверный → 401 без обработки', async () => {
    process.env.CDEK_WEBHOOK_SECRET = 's3cr3t';
    const res = await callPost('http://localhost/api/cdek/webhook?key=wrong', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(401);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('секрет задан, ключ верный → 200', async () => {
    process.env.CDEK_WEBHOOK_SECRET = 's3cr3t';
    const res = await callPost('http://localhost/api/cdek/webhook?key=s3cr3t', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    expect(handleWebhookEventMock).toHaveBeenCalledOnce();
  });
});

describe('POST /api/cdek/webhook — боевые ключи без настроенной защиты (security)', () => {
  it('боевые ключи + НЕТ секрета + ПУСТОЙ whitelist → 401 (роут не работает открытым)', async () => {
    // Раньше CDEK_TEST_MODE=true открывал write-путь к боевым orders — закрыто.
    delete process.env.CDEK_WEBHOOK_SECRET;
    delete process.env.CDEK_WEBHOOK_IPS;
    process.env.CDEK_TEST_MODE = 'true';
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(401);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/cdek/webhook — парсинг и идемпотентность', () => {
  it('битый JSON → 200 warn=invalid_json (без ретраев СДЭК)', async () => {
    const res = await callPost('http://localhost/api/cdek/webhook', {
      body: '{ not json',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warn?: string };
    expect(json.ok).toBe(false);
    expect(json.warn).toBe('invalid_json');
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('дубликат (handler → duplicate:true) → всё равно 200', async () => {
    handleWebhookEventMock.mockResolvedValueOnce({ processed: false, duplicate: true });
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; duplicate: boolean };
    expect(json.ok).toBe(true);
    expect(json.duplicate).toBe(true);
  });

  it('ошибка хендлера → 200 warn=handler_error', async () => {
    handleWebhookEventMock.mockRejectedValueOnce(new Error('boom'));
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warn?: string };
    expect(json.ok).toBe(false);
    expect(json.warn).toBe('handler_error');
  });

  it('IP источника пробрасывается в handleWebhookEvent (для cdek_status_log.ip)', async () => {
    await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(handleWebhookEventMock).toHaveBeenCalledOnce();
    expect(handleWebhookEventMock).toHaveBeenCalledWith(expect.anything(), VALID_IP);
  });
});

describe('POST /api/cdek/webhook — module-gate и mock-режим', () => {
  it('модуль cdek выключен → 404', async () => {
    process.env.ADMIK_MODULES = 'catalog,orders';
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': VALID_IP },
    });
    expect(res.status).toBe(404);
    expect(handleWebhookEventMock).not.toHaveBeenCalled();
  });

  it('mock-режим (нет боевых ключей) + пустой whitelist → bypass, 200', async () => {
    // edu/CI: bypass допустим ТОЛЬКО при отсутствии боевых ключей (isMock).
    delete process.env.CDEK_ACCOUNT;
    delete process.env.CDEK_SECRET;
    delete process.env.CDEK_WEBHOOK_IPS;
    delete process.env.CDEK_WEBHOOK_SECRET;
    const res = await callPost('http://localhost/api/cdek/webhook', {
      ...body(),
      headers: { ...(body().headers as Record<string, string>), 'x-forwarded-for': FOREIGN_IP },
    });
    expect(res.status).toBe(200);
    expect(handleWebhookEventMock).toHaveBeenCalledOnce();
  });
});
