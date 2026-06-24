import { describe, it, expect, vi } from 'vitest';
import { CdekManager } from '@/lib/cdek/manager';
import { getCdekConfig } from '@/lib/cdek/config';
import { CityService } from '@/lib/cdek/services/city';

/**
 * Тесты CityService (поиск городов СДЭК, docs/13 §2). Mock-путь — фикстуры.
 * Real-путь — замоканный manager.client (без сети): маппинг /v2/location/cities.
 */

const mockCfg = getCdekConfig({ NODE_ENV: 'test' });
const realCfg = getCdekConfig({
  NODE_ENV: 'test',
  CDEK_ACCOUNT: 'acc-1',
  CDEK_SECRET: 'sec-1',
  CDEK_BASE_URL: 'https://api.edu.cdek.ru',
});

describe('cdek/city — mock-путь (фикстуры)', () => {
  const svc = new CityService(new CdekManager({ config: mockCfg }));

  it('находит Москву по подстроке', async () => {
    const cities = await svc.searchCities('моск');
    expect(cities.length).toBeGreaterThan(0);
    expect(cities[0]).toMatchObject({ code: 44, name: 'Москва' });
  });

  it('регистронезависимо', async () => {
    const cities = await svc.searchCities('САНКТ');
    expect(cities.some((c) => c.code === 137)).toBe(true);
  });

  it('короткий запрос (<2) → пусто', async () => {
    expect(await svc.searchCities('м')).toEqual([]);
    expect(await svc.searchCities('')).toEqual([]);
    expect(await svc.searchCities('  ')).toEqual([]);
  });

  it('нет фикстурного совпадения → один синтетический город (демо-fallback, не тупик чекаута)', async () => {
    // mock-режим (нет ключей СДЭК): город вне фикстур не должен давать пустой
    // автокомплит — иначе нельзя выбрать город → недостижимы ПВЗ/расчёт (#12).
    const cities = await svc.searchCities('Зззнетово');
    expect(cities.length).toBe(1);
    expect(cities[0]!.code).toBeGreaterThanOrEqual(1_000_000);
    expect(cities[0]!.name).toMatch(/Зззнетово/i);
  });
});

describe('cdek/city — real-путь (замоканный manager.client)', () => {
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

  const rawCity = { code: 270, city: 'Новосибирск', region: 'Новосибирская область' };

  it('маппит ответ /v2/location/cities (массив)', async () => {
    const { m } = makeManager([rawCity]);
    const cities = await new CityService(m).searchCities('новос');
    expect(cities).toEqual([{ code: 270, name: 'Новосибирск', region: 'Новосибирская область' }]);
  });

  it('передаёт city/country_codes в query', async () => {
    const { m, fetchImpl } = makeManager([rawCity]);
    await new CityService(m).searchCities('новос');
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/v2/location/cities');
    expect(String(url)).toContain('country_codes=RU');
  });

  it('отбрасывает записи без code', async () => {
    const { m } = makeManager([{ city: 'Безкода' }, rawCity]);
    const cities = await new CityService(m).searchCities('абвгд');
    expect(cities).toEqual([{ code: 270, name: 'Новосибирск', region: 'Новосибирская область' }]);
  });

  it('устойчив к не-массиву в ответе', async () => {
    const { m } = makeManager({ unexpected: true });
    expect(await new CityService(m).searchCities('абвгд')).toEqual([]);
  });
});
