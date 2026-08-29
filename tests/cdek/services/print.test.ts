import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Тесты PrintService (docs/08 §7.3).
 *
 * mock → фейковый PDF-URL (MOCK_PRINT_URL), без сети. real → двухшаговый
 * запрос+опрос (POST задачи → GET url) на замоканном client.
 */

const updateShipmentMock = vi.fn(async () => null);
type ShipmentLookup = { orderId: string; cdekUuid: string } | null;
const getShipmentMock = vi.fn(
  async (): Promise<ShipmentLookup> => ({ orderId: 'ord-1', cdekUuid: 'u-1' }),
);
vi.mock('@/lib/cdek/repository', () => ({
  getShipmentByOrderId: (...a: unknown[]) => getShipmentMock(...(a as [])),
  updateShipmentByOrderId: (...a: unknown[]) => updateShipmentMock(...(a as [])),
}));

import { PrintService } from '@/lib/cdek/services/print';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import { MOCK_PRINT_URL } from '@/lib/cdek/mock';

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
const realCfg = getCdekConfig({
  NODE_ENV: 'test',
  CDEK_ACCOUNT: 'acc',
  CDEK_SECRET: 'sec',
  CDEK_BASE_URL: 'https://api.edu.cdek.ru',
});

describe('cdek/print — mock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getShipmentLabel в mock → фейковый PDF-URL', async () => {
    const svc = new PrintService(new CdekManager({ config: mockCfg }));
    const { url } = await svc.getShipmentLabel('ord-1');
    expect(url).toBe(MOCK_PRINT_URL);
  });

  it('mock не ходит в client (нет cdek_uuid требований)', async () => {
    const svc = new PrintService(new CdekManager({ config: mockCfg }));
    const r = await svc.getShipmentLabel('ord-1', { kind: 'barcode' });
    expect(r.url).toBe(MOCK_PRINT_URL);
  });
});

describe('cdek/print — real (замоканный client, двухшаговый)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getShipmentMock.mockResolvedValue({ orderId: 'ord-1', cdekUuid: 'u-1' });
  });

  it('накладная: POST /v2/print/orders → GET url', async () => {
    let step = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      step++;
      if (init?.method === 'POST' || String(url).endsWith('/v2/print/orders')) {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ entity: { uuid: 'print-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ url: 'https://cdek/waybill.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const svc = new PrintService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));
    const { url } = await svc.getShipmentLabel('ord-1', { kind: 'waybill' });
    expect(url).toBe('https://cdek/waybill.pdf');
    expect(step).toBeGreaterThanOrEqual(2); // POST задачи + GET url
  });

  /**
   * 🔴 РЕГРЕСС-ТЕСТ БОЕВОГО БАГА (carre, 2026-08-29).
   *
   * Тест выше мокает ответ опроса как `{ url }` — поля ВЕРХНЕГО уровня. Такого
   * ответа СДЭК не присылает: реальный формат кладёт ссылку ВНУТРЬ `entity`:
   *   { "entity": { "uuid": "...", "url": ".../<uuid>.pdf",
   *                 "statuses": [{"code":"READY","name":"Сформирован"}] },
   *     "requests": [{ "state": "SUCCESSFUL" }] }
   * Из-за этого код читал `raw.url`, всегда получал undefined и падал с
   * «PDF печати ещё не готов» ДАЖЕ при статусе READY — печать накладной была
   * сломана во всех боевых магазинах, а зелёный тест это маскировал, потому что
   * проверял выдуманный формат.
   *
   * Этот тест воспроизводит НАСТОЯЩИЙ ответ боевого API (снят живым вызовом).
   */
  it('накладная: url приходит внутри entity (реальный формат API СДЭК)', async () => {
    const realApiResponse = {
      entity: {
        uuid: '16e2dcf3-dbf6-4109-8fa0-9928f6d1d764',
        orders: [{ order_uuid: '1f684ab6-fc12-4b8c-9b82-5431998f12eb' }],
        copy_count: 1,
        url: 'https://api.cdek.ru/v2/print/orders/16e2dcf3-dbf6-4109-8fa0-9928f6d1d764.pdf',
        statuses: [
          { code: 'ACCEPTED', name: 'Принят' },
          { code: 'PROCESSING', name: 'Формируется' },
          { code: 'READY', name: 'Сформирован' },
        ],
      },
      requests: [{ request_uuid: '2c30d7ef', type: 'CREATE', state: 'SUCCESSFUL' }],
      related_entities: [],
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body =
        init?.method === 'POST' ? { entity: { uuid: 'print-1' } } : realApiResponse;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const svc = new PrintService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));

    const { url } = await svc.getShipmentLabel('ord-1', { kind: 'waybill' });
    expect(url).toBe(realApiResponse.entity.url);
  });

  /** ШК — тот же формат ответа, что и накладная. */
  it('ШК: url приходит внутри entity (реальный формат API СДЭК)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body =
        init?.method === 'POST'
          ? { entity: { uuid: 'print-bc' } }
          : { entity: { uuid: 'print-bc', url: 'https://api.cdek.ru/v2/print/barcodes/print-bc.pdf' } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const svc = new PrintService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));

    const { url } = await svc.getShipmentLabel('ord-1', { kind: 'barcode' });
    expect(url).toBe('https://api.cdek.ru/v2/print/barcodes/print-bc.pdf');
  });

  it('нет отправления → ошибка', async () => {
    getShipmentMock.mockResolvedValue(null);
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const svc = new PrintService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));
    await expect(svc.getShipmentLabel('ord-1')).rejects.toThrow();
  });
});
