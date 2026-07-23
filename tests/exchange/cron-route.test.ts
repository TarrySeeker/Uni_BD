import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Секрет-гейт и диспетчеризация роута /api/cron/exchange/[task]
 * (автоматический пересчёт курсов ЦБ по расписанию).
 *
 * Ожидания взяты ИЗ КОДА роута (app/api/cron/exchange/[task]/route.ts):
 *   • неизвестная задача → 404 (проверяется ДО секрета);
 *   • cron-секрет инстанса не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ отсутствует/не совпал → 401;
 *   • верный ключ → 200 { ok:true, task, stats } со статистикой воркера;
 *   • воркер бросил → 500 worker_error (детали наружу не утекают);
 *   • воркер вернул ok:false (ЦБ недоступен) → 502 (cron-контейнер зовёт curl -fsS,
 *     который смотрит ТОЛЬКО на HTTP-код: 200 маскировал бы провал прогона);
 *   • базовая валюта магазина не RUB → 200 { skipped:true } (как module_disabled
 *     у /api/cron/cdek и /api/cron/payments — это не сбой, а неприменимость источника).
 *
 * Воркер мокается — тест не ходит ни в сеть ЦБ, ни в БД.
 * Стиль/моки — как в tests/cdek/cron.test.ts и tests/payments/tbank/cron.test.ts.
 */

const SECRET = 's3cr3t';
const URL_OK = 'http://localhost/api/cron/exchange/update-rates';

/** Базовая валюта магазина, которую видит роут (подменяется по тесту). */
let baseCurrency: string | undefined = 'RUB';

vi.mock('@/lib/config/settings', () => ({
  getEffectiveSettings: async () => ({ currency: { code: baseCurrency } }),
}));

describe('cron route /api/cron/exchange/[task] — защита секретом и диспетчеризация', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIG };
    baseCurrency = 'RUB';
  });

  afterEach(() => {
    process.env = { ...ORIG };
    vi.resetModules();
    vi.doUnmock('@/lib/exchange/service');
  });

  async function callPost(task: string, url: string): Promise<Response> {
    const { POST } = await import('@/app/api/cron/exchange/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(url), { method: 'POST' });
    return POST(req, { params: Promise.resolve({ task }) });
  }

  it('неизвестная задача → 404 (даже с верным ключом)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('bogus', `http://localhost/api/cron/exchange/bogus?key=${SECRET}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unknown_task');
  });

  it('секрет не сконфигурирован → 503 (роут выключен, а НЕ открыт)', async () => {
    delete process.env.CDEK_CRON_SECRET;
    const res = await callPost('update-rates', `${URL_OK}?key=anything`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('cron_secret_not_configured');
  });

  it('без ключа → 401', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('update-rates', URL_OK);
    expect(res.status).toBe(401);
  });

  it('неверный ключ → 401', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const res = await callPost('update-rates', `${URL_OK}?key=wrong`);
    expect(res.status).toBe(401);
  });

  it('верный ключ в query → 200 со статистикой воркера', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => ({ ok: true, updated: 1, missing: [] as string[] }));
    vi.doMock('@/lib/exchange/service', () => ({ runUpdateExchangeRatesProd: run }));

    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      task: string;
      stats: { ok: boolean; updated: number };
    };
    expect(body.ok).toBe(true);
    expect(body.task).toBe('update-rates');
    expect(body.stats.updated).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('верный ключ в заголовке X-Cron-Secret (как ходит cron-контейнер) → 200', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    const run = vi.fn(async () => ({ ok: true, updated: 0, missing: [] as string[] }));
    vi.doMock('@/lib/exchange/service', () => ({ runUpdateExchangeRatesProd: run }));

    const { POST } = await import('@/app/api/cron/exchange/[task]/route');
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(new URL(URL_OK), {
      method: 'POST',
      headers: { 'x-cron-secret': SECRET },
    });
    const res = await POST(req, { params: Promise.resolve({ task: 'update-rates' }) });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('воркер бросил → 500 worker_error без деталей наружу', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/exchange/service', () => ({
      runUpdateExchangeRatesProd: vi.fn(async () => {
        throw new Error('secret-ish внутренняя деталь');
      }),
    }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).toContain('worker_error');
    expect(raw).not.toContain('secret-ish');
    spy.mockRestore();
  });

  it('ЦБ недоступен (воркер вернул ok:false) → 502 с причиной, а НЕ зелёный 200', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/exchange/service', () => ({
      runUpdateExchangeRatesProd: vi.fn(async () => ({
        ok: false,
        updated: 0,
        missing: [] as string[],
        reason: 'fetch_failed',
      })),
    }));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    // curl -fsS в cron-контейнере реагирует только на код: не-2xx обязателен.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; reason?: string; task?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('fetch_failed');
    expect(body.task).toBe('update-rates');
    spy.mockRestore();
  });

  it('успешный прогон остаётся 2xx (не-2xx только на реальном сбое)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    vi.doMock('@/lib/exchange/service', () => ({
      runUpdateExchangeRatesProd: vi.fn(async () => ({
        ok: true,
        updated: 0,
        missing: ['GBP'],
      })),
    }));
    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
  });

  it('базовая валюта магазина не RUB → 200 skipped, воркер НЕ запускается', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    baseCurrency = 'USD';
    const run = vi.fn(async () => ({ ok: true, updated: 1, missing: [] as string[] }));
    vi.doMock('@/lib/exchange/service', () => ({ runUpdateExchangeRatesProd: run }));

    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    // Неприменимость источника — не сбой инфраструктуры: крон не должен алертить сутками.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('unsupported_base');
    // Главное: курсы ЦБ на не-рублёвом магазине не записываются вовсе.
    expect(run).not.toHaveBeenCalled();
  });

  it('базовая валюта RUB → воркер запускается (гейт не мешает штатному магазину)', async () => {
    process.env.CDEK_CRON_SECRET = SECRET;
    baseCurrency = 'RUB';
    const run = vi.fn(async () => ({ ok: true, updated: 1, missing: [] as string[] }));
    vi.doMock('@/lib/exchange/service', () => ({ runUpdateExchangeRatesProd: run }));

    const res = await callPost('update-rates', `${URL_OK}?key=${SECRET}`);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * Guard: расписание автообновления курсов должно быть ЗАРЕГИСТРИРОВАНО в crontab
 * cron-контейнера (docker-compose.yml). Без этой строки логика пересчёта готова,
 * но на стенде курс заморожен на дате последнего ручного сохранения формы —
 * «автоматический пересчёт по курсу ЦБ» де-факто не работает (п.10 ТЗ).
 *
 * Читаем исходник файлом (как tests/storefront-ui/*): вёрстку/конфиги в этом
 * репозитории иначе не проверить.
 */
describe('docker-compose: crontab содержит задачу обновления курсов ЦБ', () => {
  const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
  const cronLine = (): string | undefined =>
    compose
      .split('\n')
      .find(
        (l) => l.includes('/api/cron/exchange/update-rates') && l.trimStart().startsWith('echo'),
      );

  it('есть строка crontab, дёргающая /api/cron/exchange/update-rates', () => {
    expect(cronLine(), 'строка crontab для exchange/update-rates не найдена').toBeTruthy();
  });

  it('задача выполняется раз в сутки (ЦБ публикует курс раз в день)', () => {
    const line = cronLine()!;
    const schedule = /echo "(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s/.exec(line);
    expect(schedule, 'не удалось разобрать расписание').toBeTruthy();
    const [, minute, hour, dom, month, dow] = schedule!;
    // раз в сутки: минута и час фиксированные, день/месяц/день недели — «каждый».
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
  });

  it('вызов идёт с cron-секретом и через тот же HIT-хелпер, что и остальные задачи', () => {
    const line = cronLine()!;
    expect(line).toContain('$$HIT');
    expect(line).toContain('$$CDEK_CRON_URL');
  });

  it('в блоке «альтернатива без контейнера» есть эквивалентная строка для внешнего планировщика', () => {
    const comment = compose
      .split('\n')
      .find((l) => l.trimStart().startsWith('#') && l.includes('/api/cron/exchange/update-rates'));
    expect(comment, 'нет комментария со строкой для внешнего планировщика').toBeTruthy();
    expect(comment!).toContain('key=');
  });
});
