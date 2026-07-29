import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cdekCities, cdekPvz } from '../../storefront/lib/api';

/**
 * АУДИТ major №19 — сбой СДЭК показывался покупателю как «в этом городе нет
 * пунктов выдачи».
 *
 * Причина: cdekCities/cdekPvz были `catch { return []; }` — ошибка транспорта или
 * сервиса (5xx, 404 module_disabled, обрыв сети) НЕОТЛИЧИМА от честно пустого
 * результата. Витрина по `list.length === 0` рисовала «нет пунктов выдачи», а у
 * автокомплита городов не рисовала вообще ничего.
 *
 * Контракт после правки: обе функции возвращают РЕЗУЛЬТАТ с признаком —
 *   { items: T[]; failed: boolean; reason?: 'unavailable' | 'error' }
 * `failed: false` — сервис ответил (пусть и пустым списком);
 * `failed: true`  — ответа по существу не было, показывать «нет пунктов» НЕЛЬЗЯ.
 */

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cdekCities — «пусто» отличимо от «сервис недоступен»', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('короткий запрос (<2 символов) — не сбой, просто пусто', async () => {
    const res = await cdekCities('м');
    expect(res.items).toEqual([]);
    expect(res.failed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('сервис ответил пустым списком → failed=false (честно нет совпадений)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([]));
    const res = await cdekCities('Зззз');
    expect(res.items).toEqual([]);
    expect(res.failed).toBe(false);
  });

  it('сервис ответил городами → items заполнены, failed=false', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([{ code: 44, name: 'Москва', region: 'Москва' }]),
    );
    const res = await cdekCities('Мос');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].name).toBe('Москва');
    expect(res.failed).toBe(false);
  });

  it('обрыв сети → failed=true, items пусты (НЕ выдавать за «ничего не найдено»)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await cdekCities('Мос');
    expect(res.items).toEqual([]);
    expect(res.failed).toBe(true);
  });

  it('5xx сервиса → failed=true', async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(502, 'upstream'));
    const res = await cdekCities('Мос');
    expect(res.failed).toBe(true);
  });

  it('404 module_disabled (модуль СДЭК выключен) → failed=true, reason=unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(404, 'module_disabled'));
    const res = await cdekCities('Мос');
    expect(res.failed).toBe(true);
    expect(res.reason).toBe('unavailable');
  });
});

describe('cdekPvz — «в городе нет ПВЗ» отличимо от «сервис недоступен»', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('пустой список от сервиса → failed=false (в городе действительно нет ПВЗ)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([]));
    const res = await cdekPvz(44);
    expect(res.items).toEqual([]);
    expect(res.failed).toBe(false);
  });

  it('список ПВЗ → items заполнены', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([{ code: 'MSK1', name: 'ПВЗ', address: 'ул. 1' }]),
    );
    const res = await cdekPvz(44);
    expect(res.items).toHaveLength(1);
    expect(res.failed).toBe(false);
  });

  it('обрыв сети → failed=true', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('boom'));
    const res = await cdekPvz(44);
    expect(res.items).toEqual([]);
    expect(res.failed).toBe(true);
  });

  it('404 module_disabled → failed=true, reason=unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(404, 'module_disabled'));
    const res = await cdekPvz(44);
    expect(res.failed).toBe(true);
    expect(res.reason).toBe('unavailable');
  });

  it('5xx → failed=true, reason=error', async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(500, 'internal'));
    const res = await cdekPvz(44);
    expect(res.failed).toBe(true);
    expect(res.reason).toBe('error');
  });
});
