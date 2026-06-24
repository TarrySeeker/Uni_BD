import { describe, it, expect, vi } from 'vitest';
import { CdekManager } from '@/lib/cdek/manager';
import { CdekError } from '@/lib/cdek/errors';
import { getCdekConfig } from '@/lib/cdek/config';

/**
 * Тесты фасада CdekManager (docs/08 §2.1). Без сети.
 * Проверяем выбор mock-vs-real: isMock, доступность mock-слоя, недоступность
 * client в mock-режиме, реальный client с замоканным fetch.
 */

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
const realCfg = getCdekConfig({
  NODE_ENV: 'test',
  CDEK_ACCOUNT: 'acc-1',
  CDEK_SECRET: 'sec-1',
  CDEK_BASE_URL: 'https://api.edu.cdek.ru',
});

describe('cdek/manager — mock-режим', () => {
  it('isMock=true при пустых ключах', () => {
    const m = new CdekManager({ config: mockCfg });
    expect(m.isMock).toBe(true);
  });

  it('mock-слой доступен и считает тариф детерминированно', () => {
    const m = new CdekManager({ config: mockCfg });
    const list = m.mock.mockCalculateAvailable([{ weight: 500 }]);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(m.mock.MOCK_OFFICES.length).toBeGreaterThan(0);
  });

  it('обращение к client в mock-режиме кидает CdekError', () => {
    const m = new CdekManager({ config: mockCfg });
    expect(() => m.client).toThrow(CdekError);
  });
});

describe('cdek/manager — реальный режим', () => {
  it('isMock=false при заданных ключах', () => {
    const m = new CdekManager({ config: realCfg });
    expect(m.isMock).toBe(false);
  });

  it('client доступен и ходит через замоканный fetch с Bearer', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok-X'), invalidate: vi.fn(async () => {}) };
    const m = new CdekManager({ config: realCfg, fetchImpl, tokenCache });

    const res = await m.client.request('GET', '/v2/orders');
    expect(res).toEqual({ ok: true });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-X');
  });

  it('client — ленивый синглтон (один и тот же инстанс)', () => {
    const m = new CdekManager({ config: realCfg, tokenCache: { getToken: async () => 't', invalidate: async () => {} } });
    expect(m.client).toBe(m.client);
  });
});
