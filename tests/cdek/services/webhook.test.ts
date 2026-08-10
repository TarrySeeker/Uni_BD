import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты WebhookService (docs/08 §8) — КЛЮЧЕВОЕ: идемпотентность.
 *
 * (а) ЧИСТЫЕ — verifyWebhookIp (матрица IP/CIDR/mock-bypass), parseEvent. Без БД.
 * (б) handleWebhookEvent — мокаем repository.insertStatusLog: inserted=false →
 *     {duplicate:true} и НЕ повторяет обработку (delivery_status не трогается).
 */

// --- Моки БД-слоёв до импорта тестируемого модуля. ---
const insertStatusLogMock = vi.fn();
const markProcessedMock = vi.fn(async () => {});
const findStatusLogByKeyMock = vi.fn(async (): Promise<unknown> => null);
type ShipmentLookup = { orderId: string; cdekUuid: string } | null;
const getShipmentByUuidMock = vi.fn(
  async (): Promise<ShipmentLookup> => ({ orderId: 'ord-1', cdekUuid: 'u-1' }),
);

vi.mock('@/lib/cdek/repository', () => ({
  insertStatusLog: (...a: unknown[]) => insertStatusLogMock(...(a as [])),
  markStatusLogProcessed: (...a: unknown[]) => markProcessedMock(...(a as [])),
  findStatusLogByKey: (...a: unknown[]) => findStatusLogByKeyMock(...(a as [])),
  getShipmentByCdekUuid: (...a: unknown[]) => getShipmentByUuidMock(...(a as [])),
}));

type OrderLookup = { order: { id: string } } | null;
const getOrderByNumberMock = vi.fn(
  async (): Promise<OrderLookup> => ({ order: { id: 'ord-1' } }),
);
vi.mock('@/lib/orders/repository', () => ({
  getOrderByNumber: (...a: unknown[]) => getOrderByNumberMock(...(a as [])),
}));

const advanceDeliveryStatusMock = vi.fn(async () => true);
vi.mock('@/lib/cdek/services/delivery-status', () => ({
  advanceDeliveryStatus: (...a: unknown[]) => advanceDeliveryStatusMock(...(a as [])),
}));

import {
  verifyWebhookIp,
  parseEvent,
  WebhookService,
  ensureWebhookSubscription,
  maskWebhookUrl,
  CDEK_WEBHOOK_PATH,
} from '@/lib/cdek/services/webhook';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });

// =============================================================================
// verifyWebhookIp — матрица (чистая).
// =============================================================================
describe('cdek/webhook — verifyWebhookIp (чистая, IP-whitelist)', () => {
  it('точный IP в whitelist → true', () => {
    expect(verifyWebhookIp('1.2.3.4', ['1.2.3.4'])).toBe(true);
  });
  it('IP вне whitelist → false', () => {
    expect(verifyWebhookIp('1.2.3.5', ['1.2.3.4'])).toBe(false);
  });
  it('CIDR /24 включает адрес подсети → true', () => {
    expect(verifyWebhookIp('1.2.3.99', ['1.2.3.0/24'])).toBe(true);
  });
  it('CIDR /24 не включает другую подсеть → false', () => {
    expect(verifyWebhookIp('1.2.4.1', ['1.2.3.0/24'])).toBe(false);
  });
  it('несколько диапазонов: хотя бы один совпал → true', () => {
    expect(verifyWebhookIp('10.0.0.5', ['1.2.3.0/24', '10.0.0.0/8'])).toBe(true);
  });
  it('пустой whitelist + НЕ mock → false (запрет)', () => {
    expect(verifyWebhookIp('1.2.3.4', [])).toBe(false);
  });
  it('пустой whitelist + mock-режим → true (bypass с warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(verifyWebhookIp('1.2.3.4', [], { isMock: true })).toBe(true);
    warn.mockRestore();
  });
  it('SECURITY: пустой whitelist + testMode (боевые ключи) → false (НЕ bypass)', () => {
    // testMode НЕ связан с mock — боевой edu-контур не должен открывать write-путь.
    expect(verifyWebhookIp('1.2.3.4', [], { testMode: true, isMock: false })).toBe(false);
  });
  it('CIDR /32 — точное совпадение', () => {
    expect(verifyWebhookIp('1.2.3.4', ['1.2.3.4/32'])).toBe(true);
    expect(verifyWebhookIp('1.2.3.5', ['1.2.3.4/32'])).toBe(false);
  });
  it('CIDR /0 — любой адрес', () => {
    expect(verifyWebhookIp('200.1.1.1', ['0.0.0.0/0'])).toBe(true);
  });
  it('мусорный IP → false', () => {
    expect(verifyWebhookIp('not-an-ip', ['1.2.3.0/24'])).toBe(false);
  });
});

// =============================================================================
// parseEvent — нормализация payload (чистая).
// =============================================================================
describe('cdek/webhook — parseEvent (чистая)', () => {
  it('извлекает uuid/number/code/date/city из attributes', () => {
    const ev = parseEvent({
      type: 'ORDER_STATUS',
      uuid: 'uuid-1',
      attributes: {
        number: 'TC-2026-000123',
        cdek_number: '1012345678',
        code: 'DELIVERED',
        status_date_time: '2026-06-18T15:00:00+0300',
        city_code: 44,
        city_name: 'Москва',
      },
    });
    expect(ev.cdekUuid).toBe('uuid-1');
    expect(ev.orderNumber).toBe('TC-2026-000123');
    expect(ev.cdekNumber).toBe('1012345678');
    expect(ev.statusCode).toBe('DELIVERED');
    expect(ev.statusName).toBe('Вручён');
    expect(ev.cityCode).toBe(44);
    expect(ev.statusDateTime).toBeInstanceOf(Date);
  });

  it('status_code (числовой fallback) если нет code', () => {
    const ev = parseEvent({ uuid: 'u', attributes: { status_code: 'ON_THE_WAY' } });
    expect(ev.statusCode).toBe('ON_THE_WAY');
  });

  it('order_uuid как fallback для cdekUuid', () => {
    const ev = parseEvent({ attributes: { order_uuid: 'ou-1', code: 'CREATED' } });
    expect(ev.cdekUuid).toBe('ou-1');
  });

  it('пустой/невалидный payload → null-поля', () => {
    expect(parseEvent(null).cdekUuid).toBeNull();
    expect(parseEvent('garbage').statusCode).toBeNull();
    expect(parseEvent({}).cdekUuid).toBeNull();
  });
});

// =============================================================================
// handleWebhookEvent — идемпотентность.
// =============================================================================
describe('cdek/webhook — handleWebhookEvent идемпотентность', () => {
  const svc = new WebhookService(new CdekManager({ config: mockCfg }));
  const payload = {
    type: 'ORDER_STATUS',
    uuid: 'u-1',
    attributes: { number: 'TC-2026-000123', code: 'DELIVERED', status_date_time: '2026-06-18T15:00:00+0300' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getOrderByNumberMock.mockResolvedValue({ order: { id: 'ord-1' } });
    advanceDeliveryStatusMock.mockResolvedValue(true);
  });

  it('новое событие (inserted=true) → processed, статус применён', async () => {
    insertStatusLogMock.mockResolvedValue({ inserted: true, entry: { id: 'log-1' } });
    const r = await svc.handleWebhookEvent(payload);
    expect(r).toEqual({ processed: true, duplicate: false });
    expect(advanceDeliveryStatusMock).toHaveBeenCalledWith('ord-1', 'delivered', expect.any(String));
    expect(markProcessedMock).toHaveBeenCalledWith('log-1');
  });

  it('IP источника пробрасывается в insertStatusLog (cdek_status_log.ip)', async () => {
    insertStatusLogMock.mockResolvedValue({ inserted: true, entry: { id: 'log-3' } });
    await svc.handleWebhookEvent(payload, '203.0.113.10');
    expect(insertStatusLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.10' }),
    );
  });

  it('IP не задан → insertStatusLog получает ip=null (без падения)', async () => {
    insertStatusLogMock.mockResolvedValue({ inserted: true, entry: { id: 'log-4' } });
    await svc.handleWebhookEvent(payload);
    expect(insertStatusLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ ip: null }),
    );
  });

  it('ДУБЛИКАТ (inserted=false, существующая запись PROCESSED) → {duplicate:true}, обработка НЕ повторяется', async () => {
    insertStatusLogMock.mockResolvedValue({ inserted: false, entry: null });
    findStatusLogByKeyMock.mockResolvedValue({ id: 'log-x', processed: true });
    const r = await svc.handleWebhookEvent(payload);
    expect(r).toEqual({ processed: false, duplicate: true });
    // НЕ трогаем delivery_status и не помечаем processed повторно.
    expect(advanceDeliveryStatusMock).not.toHaveBeenCalled();
    expect(markProcessedMock).not.toHaveBeenCalled();
  });

  it('#10: inserted=false но запись НЕ processed (прошлый транзиентный сбой) → ПЕРЕОБРАБАТЫВАЕТ', async () => {
    // insertStatusLog вернул дубль, но прошлая доставка упала до markProcessed →
    // переход потерян. Ретрай находит необработанную запись и переобрабатывает.
    insertStatusLogMock.mockResolvedValue({ inserted: false, entry: null });
    findStatusLogByKeyMock.mockResolvedValue({ id: 'log-y', processed: false });
    const r = await svc.handleWebhookEvent(payload);
    expect(r).toEqual({ processed: true, duplicate: false });
    expect(advanceDeliveryStatusMock).toHaveBeenCalledWith('ord-1', 'delivered', expect.any(String));
    expect(markProcessedMock).toHaveBeenCalledWith('log-y');
  });

  it('заказ не найден (ни по number, ни по uuid) → no-op', async () => {
    getOrderByNumberMock.mockResolvedValue(null);
    getShipmentByUuidMock.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await svc.handleWebhookEvent(payload);
    expect(r).toEqual({ processed: false, duplicate: false });
    expect(insertStatusLogMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('payload без uuid/кода → no-op без записи в лог', async () => {
    const r = await svc.handleWebhookEvent({ attributes: {} });
    expect(r).toEqual({ processed: false, duplicate: false });
    expect(insertStatusLogMock).not.toHaveBeenCalled();
  });

  it('поиск по cdek_uuid когда number не дал заказ', async () => {
    insertStatusLogMock.mockResolvedValue({ inserted: true, entry: { id: 'log-2' } });
    getOrderByNumberMock.mockResolvedValue(null);
    getShipmentByUuidMock.mockResolvedValue({ orderId: 'ord-9', cdekUuid: 'u-1' });
    const r = await svc.handleWebhookEvent(payload);
    expect(r.processed).toBe(true);
    expect(advanceDeliveryStatusMock).toHaveBeenCalledWith('ord-9', 'delivered', expect.any(String));
  });
});

// =============================================================================
// ensureWebhookSubscription — регистрация подписки в СДЭК (POST /v2/webhooks).
//
// Боевой гэп: без подписки вебхуки не приходят вообще. Функция идемпотентна:
// GET /v2/webhooks → сравнение с целевым URL → POST недостающих; подписки с
// нашим path и устаревшим доменом пересоздаются (DELETE+POST); ЧУЖИЕ url не
// трогаются. mock-режим → no-op.
// =============================================================================
describe('cdek/webhook — ensureWebhookSubscription', () => {
  /** Конфиг боевого контура с секретом вебхука. */
  const liveCfg = getCdekConfig({
    NODE_ENV: 'test',
    CDEK_ACCOUNT: 'acc',
    CDEK_SECRET: 'sec',
    CDEK_BASE_URL: 'https://api.edu.cdek.ru',
    CDEK_WEBHOOK_SECRET: 'whsec',
  });
  const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
  const BASE = 'https://shop.example.com';
  const TARGET = `${BASE}${CDEK_WEBHOOK_PATH}?key=whsec`;

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => vi.clearAllMocks());

  it('mock-режим → no-op с mock:true (сеть не трогается)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: mockCfg, fetchImpl }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.mock).toBe(true);
    expect(report.created).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('нет публичного URL приложения → errors без сетевых вызовов', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => null,
    });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.created).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('нет ни секрета, ни IP-whitelist → errors (роут отвечал бы 401 и СДЭК отключил бы подписку)', async () => {
    const cfgNoAuth = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: cfgNoAuth, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('подписок нет → POST /v2/webhooks с {type: ORDER_STATUS, url: base+path?key=…} → created', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET') return jsonResponse([]);
      return jsonResponse({ entity: { uuid: 'sub-1' }, requests: [{ state: 'SUCCESSFUL' }] });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });

    expect(report.errors).toEqual([]);
    expect(report.created).toHaveLength(1);
    expect(report.created[0]!.type).toBe('ORDER_STATUS');
    expect(report.created[0]!.uuid).toBe('sub-1');
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.body).toEqual({ type: 'ORDER_STATUS', url: TARGET });
    // Секрет не светится в отчёте (маскирование для UI/аудита).
    expect(JSON.stringify(report)).not.toContain('whsec');
  });

  it('подписка с нашим URL уже есть → kept, POST/DELETE не вызываются (идемпотентность)', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse([{ uuid: 'sub-keep', type: 'ORDER_STATUS', url: TARGET }]);
      }
      throw new Error(`неожиданный ${method}`);
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });

    expect(report.kept).toHaveLength(1);
    expect(report.kept[0]!.uuid).toBe('sub-keep');
    expect(report.created).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('наш path на УСТАРЕВШЕМ домене → DELETE старой + POST новой (пересоздание)', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(`${method} ${String(url)}`);
      if (method === 'GET') {
        return jsonResponse([
          { uuid: 'sub-old', type: 'ORDER_STATUS', url: `https://old-domain.example${CDEK_WEBHOOK_PATH}?key=whsec` },
        ]);
      }
      if (method === 'DELETE') return jsonResponse({});
      return jsonResponse({ entity: { uuid: 'sub-new' }, requests: [] });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });

    expect(report.deleted).toHaveLength(1);
    expect(report.deleted[0]!.uuid).toBe('sub-old');
    expect(report.created).toHaveLength(1);
    expect(methods.some((m) => m.startsWith('DELETE ') && m.includes('/v2/webhooks/sub-old'))).toBe(true);
  });

  it('ЧУЖАЯ подписка (другой path) НЕ удаляется — мультитенантная осторожность', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'GET') {
        return jsonResponse([
          { uuid: 'sub-foreign', type: 'ORDER_STATUS', url: 'https://other-system.example/hooks/cdek' },
        ]);
      }
      if (method === 'DELETE') throw new Error('чужую подписку удалять нельзя');
      return jsonResponse({ entity: { uuid: 'sub-ours' }, requests: [] });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });

    expect(report.deleted).toEqual([]);
    expect(report.created).toHaveLength(1);
    expect(report.errors).toEqual([]);
    expect(methods).not.toContain('DELETE');
  });

  it('эквивалентный URL с другим порядком query-параметров → kept (нормализация сравнения)', async () => {
    // СДЭК может вернуть URL в нормализованном виде — «наша» подписка не должна
    // пересоздаваться на каждом запуске.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse([
          { uuid: 'sub-eq', type: 'ORDER_STATUS', url: `${BASE}${CDEK_WEBHOOK_PATH}/?key=whsec` },
        ]);
      }
      throw new Error(`неожиданный ${method}`);
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.kept).toHaveLength(1);
    expect(report.deleted).toEqual([]);
    expect(report.created).toEqual([]);
  });

  it('POST вернул requests[].state INVALID с errors[] → errors в отчёте, created пуст', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      return jsonResponse({
        requests: [
          { state: 'INVALID', errors: [{ code: 'v2_webhook_type_incorrect', message: 'bad type' }] },
        ],
      });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.created).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.join(' ')).toContain('v2_webhook_type_incorrect');
  });

  it('секрет из URL в сообщении ошибки СДЭК маскируется в report.errors (аудит #4)', async () => {
    // СДЭК на POST /v2/webhooks отражает присланный url (с ?key=<секрет>) в тексте
    // ошибки валидации. report.errors пишется в audit_log и показывается оператору —
    // секрет утекать не должен.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      return jsonResponse({
        requests: [
          {
            state: 'INVALID',
            errors: [{ code: 'v2_webhook_url_incorrect', message: `bad url: ${TARGET}` }],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.errors.length).toBeGreaterThan(0);
    const joined = report.errors.join(' ');
    expect(joined).not.toContain('whsec'); // секрет НЕ утёк
    expect(joined).toContain('key=***'); // замаскирован
  });

  it('GET /v2/webhooks упал (HTTP 500 после ретраев) → errors, POST не пробуем', async () => {
    let postCalled = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse({ errors: [{ code: 'boom', message: 'x' }] }, 500);
      postCalled = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: liveCfg, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(postCalled).toBe(false);
  });

  it('без секрета, но с IP-whitelist → подписка создаётся на URL без ?key=', async () => {
    const cfgIpOnly = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_ACCOUNT: 'acc',
      CDEK_SECRET: 'sec',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
      CDEK_WEBHOOK_IPS: '203.0.113.0/24',
      CDEK_WEBHOOK_TRUST_PROXY: 'true',
    });
    let postedUrl: string | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse([]);
      postedUrl = (JSON.parse(String(init?.body)) as { url: string }).url;
      return jsonResponse({ entity: { uuid: 'sub-ip' }, requests: [] });
    }) as unknown as typeof fetch;

    const report = await ensureWebhookSubscription({
      manager: new CdekManager({ config: cfgIpOnly, fetchImpl, tokenCache }),
      resolveBaseUrl: async () => BASE,
    });
    expect(report.created).toHaveLength(1);
    expect(postedUrl).toBe(`${BASE}${CDEK_WEBHOOK_PATH}`);
  });
});
