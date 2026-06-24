import { describe, it, expect, vi } from 'vitest';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import { PvzService } from '@/lib/cdek/services/pvz';

/**
 * Тесты PvzService (docs/08 §6). Mock-путь — фикстуры. Real-путь — замоканный
 * manager.client (без сети): маппинг ответа /v2/deliverypoints.
 */

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
const realCfg = getCdekConfig({
  NODE_ENV: 'test',
  CDEK_ACCOUNT: 'acc-1',
  CDEK_SECRET: 'sec-1',
  CDEK_BASE_URL: 'https://api.edu.cdek.ru',
});

describe('cdek/pvz — mock-путь (фикстуры)', () => {
  const m = new CdekManager({ config: mockCfg });
  const pvz = new PvzService(m);

  it('listOffices по городу 44 непуст', async () => {
    const offices = await pvz.listOffices({ cityCode: 44 });
    expect(offices.length).toBeGreaterThan(0);
    expect(offices.every((o) => o.cityCode === 44)).toBe(true);
  });

  it('listOffices по городу 137 (СПб) непуст', async () => {
    const offices = await pvz.listOffices({ cityCode: 137 });
    expect(offices.length).toBeGreaterThan(0);
  });

  it('фильтр по типу POSTAMAT', async () => {
    const offices = await pvz.listOffices({ type: 'POSTAMAT' });
    expect(offices.length).toBeGreaterThan(0);
    expect(offices.every((o) => o.type === 'POSTAMAT')).toBe(true);
  });

  it('listOffices без фильтров возвращает все фикстуры', async () => {
    const offices = await pvz.listOffices({});
    expect(offices.length).toBeGreaterThanOrEqual(3);
  });

  it('findOffice по существующему коду', async () => {
    const office = await pvz.findOffice('MSK1');
    expect(office).not.toBeNull();
    expect(office?.code).toBe('MSK1');
  });

  it('findOffice по несуществующему коду → null', async () => {
    const office = await pvz.findOffice('NOPE');
    expect(office).toBeNull();
  });

  it('findOffice пустой код → null', async () => {
    expect(await pvz.findOffice('')).toBeNull();
    expect(await pvz.findOffice('   ')).toBeNull();
  });
});

describe('cdek/pvz — real-путь (замоканный manager.client)', () => {
  function makeManager(responseBody: unknown) {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const tokenCache = { getToken: vi.fn(async () => 'tok-X'), invalidate: vi.fn(async () => {}) };
    return { m: new CdekManager({ config: realCfg, fetchImpl, tokenCache }), fetchImpl };
  }

  const rawOffice = {
    code: 'MSK77',
    name: 'ПВЗ Москва тест',
    location: {
      address_full: 'Москва, ул. Тестовая, 1',
      city_code: 44,
      latitude: 55.7,
      longitude: 37.6,
    },
    type: 'PVZ',
    work_time: 'Пн-Пт 10-20',
  };

  it('listOffices маппит ответ /v2/deliverypoints (массив)', async () => {
    const { m } = makeManager([rawOffice]);
    const pvz = new PvzService(m);
    const offices = await pvz.listOffices({ cityCode: 44 });
    expect(offices).toHaveLength(1);
    expect(offices[0].code).toBe('MSK77');
    expect(offices[0].address).toBe('Москва, ул. Тестовая, 1');
    expect(offices[0].cityCode).toBe(44);
    expect(offices[0].location).toEqual({ latitude: 55.7, longitude: 37.6 });
    expect(offices[0].workTime).toBe('Пн-Пт 10-20');
  });

  it('listOffices передаёт фильтры в query', async () => {
    const { m, fetchImpl } = makeManager([rawOffice]);
    const pvz = new PvzService(m);
    await pvz.listOffices({ cityCode: 44, type: 'PVZ' });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/v2/deliverypoints');
    expect(String(url)).toContain('city_code=44');
    expect(String(url)).toContain('type=PVZ');
  });

  it('findOffice по коду → первый из ответа', async () => {
    const { m } = makeManager([rawOffice]);
    const pvz = new PvzService(m);
    const office = await pvz.findOffice('MSK77');
    expect(office?.code).toBe('MSK77');
  });

  it('findOffice → null когда СДЭК вернул пустой массив', async () => {
    const { m } = makeManager([]);
    const pvz = new PvzService(m);
    expect(await pvz.findOffice('MSK77')).toBeNull();
  });

  it('listOffices устойчив к не-массиву в ответе', async () => {
    const { m } = makeManager({ unexpected: true });
    const pvz = new PvzService(m);
    expect(await pvz.listOffices({ cityCode: 44 })).toEqual([]);
  });
});
