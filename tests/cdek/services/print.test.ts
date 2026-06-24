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

  it('нет отправления → ошибка', async () => {
    getShipmentMock.mockResolvedValue(null);
    const tokenCache = { getToken: vi.fn(async () => 'tok'), invalidate: vi.fn(async () => {}) };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const svc = new PrintService(new CdekManager({ config: realCfg, fetchImpl, tokenCache }));
    await expect(svc.getShipmentLabel('ord-1')).rejects.toThrow();
  });
});
