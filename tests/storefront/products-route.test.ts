import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Тесты валидации uuid-параметров в публичном списке товаров
 * (GET /api/storefront/v1/products, BUG #6, reliability).
 *
 * brandId/categoryId уходят в SQL с ::uuid-кастом (lib/catalog/repository
 * listProducts). До фикса они брались из query без проверки формата → не-UUID
 * значение роняло Postgres на uuid-cast → 500 вместо корректного 400.
 *
 * Семантика после фикса: brandId/categoryId — это ТОЧНЫЕ id-фильтры (не поиск).
 * Невалидный формат — ошибка клиента → 400 bad_request ДО запроса в БД
 * (listProducts даже не вызывается). Корректный uuid проходит как раньше.
 *
 * Мокаем lib/catalog/repository и lib/storefront/queries, чтобы тест не требовал
 * БД: при наличии валидации мок listProducts не должен вызываться для мусора.
 */

const ORIGINAL = { ...process.env };
const KEY = 'sk_secret';

// Имитация Postgres-ошибки uuid-cast (как в проде, если мусор дойдёт до БД).
class FakePgUuidCastError extends Error {
  code = '22P02'; // invalid_text_representation
}

const listProducts = vi.fn(
  async (filter: {
    brandId?: string;
    categoryId?: string;
    page?: number;
    pageSize?: number;
    offset?: number;
  }) => {
    // Воспроизводим прод-поведение: ::uuid-каст падает на не-UUID значении.
    const isUuid = (v: string | undefined): boolean =>
      v === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!isUuid(filter.brandId) || !isUuid(filter.categoryId)) {
      throw new FakePgUuidCastError('invalid input syntax for type uuid');
    }
    return { rows: [], total: 0 };
  },
);

vi.mock('@/lib/catalog/repository', () => ({
  listProducts,
}));

vi.mock('@/lib/storefront/queries', () => ({
  getActiveCategoryIdBySlug: vi.fn(async () => null),
}));

vi.mock('@/lib/storefront/dto', () => ({
  toProductListItemDto: (r: unknown) => r,
}));

function setEnv() {
  process.env.ADMIK_MODULES = 'catalog,orders,cdek';
  process.env.STOREFRONT_API_KEYS = KEY;
  process.env.STOREFRONT_ALLOWED_ORIGINS = '';
}

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/storefront/v1/products/route');
}

function authedGet(url: string) {
  return new Request(url, { headers: { 'x-storefront-key': KEY } });
}

async function get(query: string): Promise<{ status: number; body: any }> {
  const { GET } = await loadRoute();
  const res = await GET(authedGet(`http://x/api/storefront/v1/products${query}`));
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

describe('storefront/products — uuid-валидация фильтров (BUG #6)', () => {
  beforeEach(() => {
    setEnv();
    listProducts.mockClear();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it('brandId=not-a-uuid → 400 bad_request, listProducts НЕ вызывается (не доходит до ::uuid)', async () => {
    const r = await get('?brandId=not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe('bad_request');
    expect(listProducts).not.toHaveBeenCalled();
  });

  it('categoryId=garbage → 400 bad_request, listProducts НЕ вызывается', async () => {
    const r = await get('?categoryId=garbage');
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe('bad_request');
    expect(listProducts).not.toHaveBeenCalled();
  });

  it('валидный brandId (uuid) → 200, фильтр пробрасывается в listProducts', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const r = await get(`?brandId=${id}`);
    expect(r.status).toBe(200);
    expect(listProducts).toHaveBeenCalledTimes(1);
    expect(listProducts.mock.calls[0]![0]).toMatchObject({ brandId: id });
  });

  it('без brandId/categoryId → 200 (без фильтров по id)', async () => {
    const r = await get('?limit=5');
    expect(r.status).toBe(200);
    expect(listProducts).toHaveBeenCalledTimes(1);
  });

  it('#2-регресс: пустой categoryId= + валидный category=slug → 200 (резолв slug, не 400)', async () => {
    // Фронт часто шлёт categoryId=${sel||''} рядом со slug. Пустая строка не
    // должна давать ложный 400 — должен сработать резолв slug.
    const r = await get('?categoryId=&category=phones');
    expect(r.status).toBe(200);
    expect(listProducts).toHaveBeenCalledTimes(1);
  });

  it('#2-регресс: пустой brandId= → 200 (трактуется как отсутствие, не 400)', async () => {
    const r = await get('?brandId=');
    expect(r.status).toBe(200);
    expect(listProducts).toHaveBeenCalledTimes(1);
  });
});

/**
 * Пагинация: СВОБОДНЫЙ offset (не кратный limit) пробрасывается в listProducts
 * БЕЗ молчаливого округления до границы страницы (BUG: minor пагинации).
 *
 * До фикса route считал page = floor(offset/limit)+1 и НЕ передавал offset, а
 * listProducts вычислял offset = (page-1)*pageSize. Для offset=10, limit=24:
 * page=1 → offset=0 → 10 запрошенных товаров молча терялись (пропуск/дубли при
 * листании). После фикса offset уходит в listProducts как есть и отражается в
 * метаданных pagination.offset ответа.
 */
describe('storefront/products — пагинация: свободный offset без округления', () => {
  beforeEach(() => {
    setEnv();
    listProducts.mockClear();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it('offset=10&limit=24 → listProducts получает offset=10 (НЕ 0), pageSize=24', async () => {
    const r = await get('?offset=10&limit=24');
    expect(r.status).toBe(200);
    expect(listProducts).toHaveBeenCalledTimes(1);
    const filter = listProducts.mock.calls[0]![0];
    expect(filter.offset).toBe(10);
    expect(filter.pageSize).toBe(24);
    // page оставлен совместимым (для логов/фолбэка), но offset имеет приоритет.
    // Формат успеха витрины — { data, ...meta }: pagination на верхнем уровне.
    expect(r.body?.pagination?.offset).toBe(10);
    expect(r.body?.pagination?.limit).toBe(24);
  });

  it('offset=25&limit=10 (не кратен) → offset=25 как есть (без округления до 20/30)', async () => {
    const r = await get('?offset=25&limit=10');
    expect(r.status).toBe(200);
    const filter = listProducts.mock.calls[0]![0];
    expect(filter.offset).toBe(25);
    expect(filter.pageSize).toBe(10);
    expect(r.body?.pagination?.offset).toBe(25);
  });

  it('offset не задан → offset=0, page=1 (дефолт, контракт не сломан)', async () => {
    const r = await get('?limit=12');
    expect(r.status).toBe(200);
    const filter = listProducts.mock.calls[0]![0];
    expect(filter.offset).toBe(0);
    expect(filter.page).toBe(1);
    expect(r.body?.pagination?.offset).toBe(0);
  });

  it('отрицательный offset → клампится в 0 (защита, без 500)', async () => {
    const r = await get('?offset=-5&limit=10');
    expect(r.status).toBe(200);
    const filter = listProducts.mock.calls[0]![0];
    expect(filter.offset).toBe(0);
    expect(r.body?.pagination?.offset).toBe(0);
  });
});
