import { describe, it, expect } from 'vitest';

/**
 * Интеграция Storefront-роутов. Требует БД (DATABASE_URL) — иначе пропуск.
 * Проверяет, что роут отдаёт товары/единый формат с CORS-заголовками.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('storefront routes (integration, требует БД)', () => {
  it('GET /products отдаёт { data, pagination } и CORS', async () => {
    const { GET } = await import('@/app/api/storefront/v1/products/route');
    const req = new Request('http://localhost/api/storefront/v1/products?limit=5', {
      headers: { origin: 'https://demo.example.com' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    const body = (await res.json()) as { data: unknown[]; pagination: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeTruthy();
  });

  it('GET /categories отдаёт дерево', async () => {
    const { GET } = await import('@/app/api/storefront/v1/categories/route');
    const res = await GET(new Request('http://localhost/api/storefront/v1/categories'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /brands отдаёт активные бренды', async () => {
    const { GET } = await import('@/app/api/storefront/v1/brands/route');
    const res = await GET(new Request('http://localhost/api/storefront/v1/brands'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});
