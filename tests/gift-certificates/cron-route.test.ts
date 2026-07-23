import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Секрет-гейт и диспетчеризация роута /api/cron/gift/[task] (догоняющий
 * автовыпуск сертификатов, ТЗ п.11).
 *
 * Ожидания — те же, что у соседних крон-роутов (cdek / payments / exchange):
 *   • неизвестная задача → 404 (проверяется ДО секрета);
 *   • cron-секрет инстанса не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ отсутствует/не совпал → 401 (сравнение постоянного времени, lib/cron/secret);
 *   • модуль orders выключен → 200 { skipped:true } (сертификаты живут в заказах);
 *   • верный ключ → 200 { ok:true, task, stats };
 *   • прогон неуспешен (stats.ok=false) → не-2xx: cron-контейнер ходит `curl -fsS`
 *     и видит ТОЛЬКО HTTP-код, поэтому 200 маскировал бы невыпущенные сертификаты;
 *   • воркер бросил → 500 worker_error без деталей наружу.
 *
 * Воркер мокается — тест не ходит в БД.
 */

const SECRET = 's3cr3t';
const URL_OK = 'http://localhost/api/cron/gift/issue-pending';

let ordersEnabled = true;

vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: async () => ordersEnabled,
}));

function stats(over: Record<string, unknown> = {}) {
  return { ok: true, scanned: 0, issued: 0, ordersIssued: 0, failed: 0, lockSkipped: false, ...over };
}

describe('cron route /api/cron/gift/[task]', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG };
    ordersEnabled = true;
  });

  afterEach(() => {
    process.env = { ...ORIG };
    vi.resetModules();
    vi.doUnmock('@/lib/gift-certificates/cron');
  });

  async function callPost(task: string, url: string): Promise<Response> {
    const { POST } = await import('@/app/api/cron/gift/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(url), { method: 'POST' });
    return POST(req, { params: Promise.resolve({ task }) });
  }

  it('неизвестная задача → 404 (даже с верным ключом)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('bogus', `http://localhost/api/cron/gift/bogus?key=${SECRET}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unknown_task');
  });

  it('секрет не сконфигурирован → 503 (роут выключен, а НЕ открыт)', async () => {
    delete process.env.CDEK_CRON_SECRET;
    const res = await callPost('issue-pending', `${URL_OK}?key=anything`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('cron_secret_not_configured');
  });

  it('без ключа → 401, воркер не запускается', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => stats());
    vi.doMock('@/lib/gift-certificates/cron', () => ({ runIssuePending: run }));
    const res = await callPost('issue-pending', URL_OK);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('неверный ключ → 401', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('issue-pending', `${URL_OK}?key=wrong`);
    expect(res.status).toBe(401);
  });

  it('ключ той же длины, но другой → 401 (сравнение не по префиксу)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('issue-pending', `${URL_OK}?key=${'x'.repeat(SECRET.length)}`);
    expect(res.status).toBe(401);
  });

  it('верный ключ в query → 200 со статистикой прогона', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => stats({ scanned: 2, issued: 1, ordersIssued: 1 }));
    vi.doMock('@/lib/gift-certificates/cron', () => ({ runIssuePending: run }));

    const res = await callPost('issue-pending', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      task: string;
      stats: { issued: number };
    };
    expect(body.ok).toBe(true);
    expect(body.task).toBe('issue-pending');
    expect(body.stats.issued).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('верный ключ в заголовке X-Cron-Secret (как ходит cron-контейнер) → 200', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => stats());
    vi.doMock('@/lib/gift-certificates/cron', () => ({ runIssuePending: run }));

    const { POST } = await import('@/app/api/cron/gift/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(URL_OK), {
      method: 'POST',
      headers: { 'x-cron-secret': SECRET },
    });
    const res = await POST(req, { params: Promise.resolve({ task: 'issue-pending' }) });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('GET работает так же (планировщики ходят обоими методами)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => stats());
    vi.doMock('@/lib/gift-certificates/cron', () => ({ runIssuePending: run }));

    const { GET } = await import('@/app/api/cron/gift/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(`${URL_OK}?key=${SECRET}`), { method: 'GET' });
    const res = await GET(req, { params: Promise.resolve({ task: 'issue-pending' }) });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('модуль orders выключен → 200 skipped, воркер НЕ запускается', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    ordersEnabled = false;
    const run = vi.fn(async () => stats());
    vi.doMock('@/lib/gift-certificates/cron', () => ({ runIssuePending: run }));

    const res = await callPost('issue-pending', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('module_disabled');
    expect(run).not.toHaveBeenCalled();
  });

  it('прогон неуспешен (stats.ok=false) → не-2xx, иначе провал выглядит успехом', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/gift-certificates/cron', () => ({
      runIssuePending: vi.fn(async () => stats({ ok: false, scanned: 3, failed: 2 })),
    }));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await callPost('issue-pending', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { ok: boolean; task?: string; stats?: { failed: number } };
    expect(body.ok).toBe(false);
    expect(body.stats?.failed).toBe(2);
    spy.mockRestore();
  });

  it('lockSkipped (параллельный прогон) остаётся 2xx — это не сбой', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/gift-certificates/cron', () => ({
      runIssuePending: vi.fn(async () => stats({ lockSkipped: true })),
    }));
    const res = await callPost('issue-pending', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
  });

  it('воркер бросил → 500 worker_error без деталей наружу', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/gift-certificates/cron', () => ({
      runIssuePending: vi.fn(async () => {
        throw new Error('secret-ish внутренняя деталь');
      }),
    }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callPost('issue-pending', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).toContain('worker_error');
    expect(raw).not.toContain('secret-ish');
    spy.mockRestore();
  });
});
