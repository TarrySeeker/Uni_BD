/**
 * Роут POST/GET /api/payments/atol/webhook.
 *
 * Сервис, настройки модулей и конфиг замоканы — проверяем ровно то, за что
 * отвечает РОУТ: порядок проверок, коды ответа и то, что решение об оплате он
 * НЕ принимает сам.
 *
 * 🔴 Почему это отдельный и довольно подробный тест. У callback АТОЛа нет
 * подписи (docs-atol/02): единственная аутентификация — секрет в query. Любая
 * дыра здесь (пропуск при ненастроенном секрете, сравнение не с тем значением,
 * трактовка paymentStatus из тела) означает, что кто угодно, узнав URL, пометит
 * неоплаченный заказ оплаченным.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import type { AtolCallback } from '@/lib/payments/atol/types';

// --- Мок сервиса: роут не должен ходить ни в API АТОЛа, ни в БД. ---
/** Форма ответа handleCallback. Объявлена явно, иначе TS сузит тип по первому
 *  значению и не даст подставить исход с `reason`. */
type CallbackResult = {
  accepted: boolean;
  inserted: boolean;
  processed: boolean;
  reason?: string;
};
const handleCallbackMock = vi.fn(
  (..._a: unknown[]): Promise<CallbackResult> =>
    Promise.resolve({ accepted: true, inserted: true, processed: true }),
);
vi.mock('@/lib/payments/atol/service', () => ({
  AtolPaymentService: class {
    get isMock() {
      return false;
    }
    handleCallback(...a: unknown[]) {
      return handleCallbackMock(...a);
    }
  },
}));

// --- Мок модульного гейта: включённость модуля живёт в БД. ---
const moduleEnabledMock = vi.fn((..._a: unknown[]) => Promise.resolve(true));
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: (...a: unknown[]) => moduleEnabledMock(...a),
}));

// --- Мок конфига: секрет подставляем, не трогая process.env. ---
const SECRET = 'atol-notification-secret-32-chars-long';
const canVerifyMock = vi.fn(() => true);
const getConfigMock = vi.fn(() => ({ notificationSecret: SECRET }));
vi.mock('@/lib/payments/atol/config', () => ({
  canVerifyAtolCallbacks: () => canVerifyMock(),
  getAtolConfig: () => getConfigMock(),
}));

const logErrorMock = vi.fn();
const logWarnMock = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: (...a: unknown[]) => logErrorMock(...a),
      warn: (...a: unknown[]) => logWarnMock(...a),
      info: () => {},
      debug: () => {},
    }),
  },
}));

import { POST, GET } from '@/app/api/payments/atol/webhook/route';

const BODY: Partial<AtolCallback> = {
  status: 'success',
  orderId: '2026-000123',
  type: 'payment',
  paymentStatus: 1,
  amount: 150000,
};

/** Запрос к вебхуку. secret === undefined → параметр не передаётся вовсе. */
function request(opts: { secret?: string | null; body?: unknown } = {}): NextRequest {
  const url = new URL('https://shop.example.com/api/payments/atol/webhook');
  if (opts.secret !== undefined && opts.secret !== null) url.searchParams.set('secret', opts.secret);
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? BODY),
  });
}

beforeEach(() => {
  handleCallbackMock.mockReset();
  handleCallbackMock.mockResolvedValue({ accepted: true, inserted: true, processed: true });
  moduleEnabledMock.mockReset();
  moduleEnabledMock.mockResolvedValue(true);
  canVerifyMock.mockReset();
  canVerifyMock.mockReturnValue(true);
  getConfigMock.mockReset();
  getConfigMock.mockReturnValue({ notificationSecret: SECRET });
  logErrorMock.mockReset();
  logWarnMock.mockReset();
});

describe('atol/webhook — module-gate', () => {
  it('модуль payments выключен → 404 и сервис не дёргается', async () => {
    moduleEnabledMock.mockResolvedValue(false);
    const res = await POST(request({ secret: SECRET }));
    expect(res.status).toBe(404);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('GET на выключенном модуле тоже 404', async () => {
    moduleEnabledMock.mockResolvedValue(false);
    expect((await GET()).status).toBe(404);
  });
});

describe('atol/webhook — аутентификация секретом в query', () => {
  /**
   * 🔴 Ключевой инвариант. Подписи нет; если секрет не настроен, проверять
   * отправителя нечем — принимать нельзя НИЧЕГО, включая запрос вообще без
   * параметра. Иначе магазин раздаёт право менять статусы заказов.
   */
  it('секрет не настроен (или короткий) → 403, log.error, сервис не вызван', async () => {
    canVerifyMock.mockReturnValue(false);
    const res = await POST(request({ secret: SECRET }));
    expect(res.status).toBe(403);
    expect(logErrorMock).toHaveBeenCalled();
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('неверный секрет → 403, log.warn, сервис не вызван', async () => {
    const res = await POST(request({ secret: 'wrong-secret-of-the-same-length!!!!!!' }));
    expect(res.status).toBe(403);
    expect(logWarnMock).toHaveBeenCalled();
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('секрет не передан вовсе → 403', async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(403);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('пустой секрет не проходит (не сравнивается «пустое с пустым»)', async () => {
    const res = await POST(request({ secret: '' }));
    expect(res.status).toBe(403);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  /** Префикс верного секрета — частый случай обрезки в логах/копипасте. */
  it('префикс верного секрета не проходит', async () => {
    const res = await POST(request({ secret: SECRET.slice(0, 10) }));
    expect(res.status).toBe(403);
  });

  it('верный секрет → сервис вызван', async () => {
    const res = await POST(request({ secret: SECRET }));
    expect(res.status).toBe(200);
    expect(handleCallbackMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 IP — только для журнала. Подделанный X-Forwarded-For не должен ни
   * пропускать без секрета, ни блокировать с верным секретом.
   */
  it('IP не участвует в аутентификации, но доезжает в сервис для журнала', async () => {
    await POST(request({ secret: SECRET }));
    const ctx = handleCallbackMock.mock.calls[0]![1] as { ip?: string | null };
    expect(ctx.ip).toBe('203.0.113.7');
  });
});

describe('atol/webhook — разбор тела', () => {
  it('не-JSON → 400', async () => {
    const res = await POST(request({ secret: SECRET, body: 'not a json at all' }));
    expect(res.status).toBe(400);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('JSON без orderId/type не разбирается → 400', async () => {
    const res = await POST(request({ secret: SECRET, body: { status: 'success' } }));
    expect(res.status).toBe(400);
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it('неизвестный type события → 400', async () => {
    const res = await POST(
      request({ secret: SECRET, body: { ...BODY, type: 'some_future_event' } }),
    );
    expect(res.status).toBe(400);
  });

  it('разобранный callback передаётся в сервис как есть', async () => {
    await POST(request({ secret: SECRET }));
    const cb = handleCallbackMock.mock.calls[0]![0] as AtolCallback;
    expect(cb.orderId).toBe('2026-000123');
    expect(cb.type).toBe('payment');
    expect(cb.paymentStatus).toBe(1);
  });
});

describe('atol/webhook — коды ответа на штатных исходах', () => {
  /**
   * 🔴 Штатный исход на аутентифицированном вебхуке = 200. Иначе АТОЛ будет
   * ретраить бесконечно то, что мы уже обработали (или никогда не обработаем).
   */
  it('дубликат (inserted:false) → 200', async () => {
    handleCallbackMock.mockResolvedValue({ accepted: true, inserted: false, processed: false });
    expect((await POST(request({ secret: SECRET }))).status).toBe(200);
  });

  it('заказ не найден → 200, а не 404', async () => {
    handleCallbackMock.mockResolvedValue({
      accepted: true,
      inserted: false,
      processed: false,
      reason: 'order_not_found',
    });
    expect((await POST(request({ secret: SECRET }))).status).toBe(200);
  });

  it('статус не маппится → 200', async () => {
    handleCallbackMock.mockResolvedValue({
      accepted: true,
      inserted: true,
      processed: false,
      reason: 'status_not_mapped',
    });
    expect((await POST(request({ secret: SECRET }))).status).toBe(200);
  });

  /**
   * 🔴 accepted:false у АТОЛа означает ровно одно: событие не отнесено ни к
   * одному заказу (заказ не найден по payment_ref). Аутентификацию оно при
   * этом прошло — секрет сверен роутом выше.
   *
   * Отвечать 403 здесь было бы ошибкой: ретраить нечего, заказа у нас нет и не
   * появится, а 4xx заставил бы АТОЛ долбить эндпоинт до исчерпания попыток.
   * (У Озона тот же флаг значит «подпись не сошлась» — там 403 по делу; у
   * АТОЛа подписи нет вовсе, и семантика другая.)
   */
  it('🔴 событие не отнесено к заказу (accepted:false) → 200, а не 403', async () => {
    handleCallbackMock.mockResolvedValue({
      accepted: false,
      inserted: false,
      processed: false,
      reason: 'order_not_found',
    });
    expect((await POST(request({ secret: SECRET }))).status).toBe(200);
  });

  /** Неожиданный сбой → 500: пусть АТОЛ повторит, обработка идемпотентна. */
  it('исключение в сервисе → 500, а не 200', async () => {
    handleCallbackMock.mockRejectedValue(new Error('db is down'));
    const res = await POST(request({ secret: SECRET }));
    expect(res.status).toBe(500);
    expect(logErrorMock).toHaveBeenCalled();
  });
});

describe('atol/webhook — GET-пинг', () => {
  it('отдаёт {ok:true, provider:"atol"} и ничего не обрабатывает', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, provider: 'atol' });
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });
});
