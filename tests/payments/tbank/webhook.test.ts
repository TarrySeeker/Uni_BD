import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Юнит-тесты обработки webhook Т-Банка (docs/15 §4.2, §7). БД и orders-репозиторий
 * замоканы — проверяем связку проверки Token + АТОМАРНОЙ обработки события + маппинга
 * статуса БЕЗ живой БД (репозиторий-зависимое — под мок, как webhook-route.test СДЭК).
 *
 * После фикса critical-бага неатомарности handleWebhook делегирует запись лога,
 * применение статуса и пометку processed ОДНОМУ атомарному вызову recordWebhookEvent
 * (одна sql.begin в репозитории). Поэтому здесь мокается ровно ОДНА функция.
 *
 * Проверяется:
 *   • невалидный Token → verified:false, recordWebhookEvent НЕ вызвана;
 *   • подмена Amount → verified:false;
 *   • валидный CONFIRMED → recordWebhookEvent(nextStatus='paid'), processed:true;
 *   • дубликат (recordWebhookEvent → inserted:false) → duplicate:true, processed:false;
 *   • REJECTED → nextStatus 'failed';
 *   • заказ не найден → recordWebhookEvent НЕ вызвана, processed:false;
 *   • неизвестный Status → recordWebhookEvent(nextStatus=null), processed:false;
 *   • parseNotification/sanitizeNotification — чистые.
 */

import { signToken } from '@/lib/payments/tbank/token';

const PASSWORD = 'webhook-test-pw';

// --- Мок репозитория (без БД): ОДНА атомарная функция recordWebhookEvent. ---
// Rest-сигнатуры (...a: unknown[]), чтобы обёртки в vi.mock могли спредить аргументы.
const recordWebhookEventMock = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ inserted: true, processed: true }),
);
const setPaymentRefAndProviderMock = vi.fn((..._a: unknown[]) => Promise.resolve());

vi.mock('@/lib/payments/tbank/repository', () => ({
  recordWebhookEvent: (...a: unknown[]) => recordWebhookEventMock(...a),
  setPaymentRefAndProvider: (...a: unknown[]) => setPaymentRefAndProviderMock(...a),
}));

const getOrderByNumberMock = vi.fn();
vi.mock('@/lib/orders/repository', () => ({
  getOrderByNumber: (...a: unknown[]) => getOrderByNumberMock(...a),
}));

// Менеджер с боевым config (password задан → verify работает), но fetch не дёргается
// (webhook не ходит в сеть). isMock=false, чтобы password присутствовал.
import { TbankManager } from '@/lib/payments/tbank/manager';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import {
  PaymentService,
  parseNotification,
  sanitizeNotification,
} from '@/lib/payments/tbank/service';

const CFG = getTbankConfig({
  NODE_ENV: 'test',
  TBANK_TERMINAL_KEY: 'tk',
  TBANK_PASSWORD: PASSWORD,
});

function service(): PaymentService {
  return new PaymentService(new TbankManager({ config: CFG }));
}

function signedBody(extra: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    TerminalKey: 'tk',
    OrderId: '2026-000123',
    Success: true,
    PaymentId: '900000001',
    Amount: 150000,
    ...extra,
  };
  body.Token = signToken(body, PASSWORD);
  return body;
}

beforeEach(() => {
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: true });
  getOrderByNumberMock.mockReset();
  getOrderByNumberMock.mockResolvedValue({ order: { id: 'order-uuid-1' }, items: [] });
});

describe('tbank/service — parseNotification / sanitizeNotification (чистые)', () => {
  it('нормализует OrderId/PaymentId/Status/Amount/Token', () => {
    const ev = parseNotification({
      OrderId: '2026-000123',
      PaymentId: 900000001, // число → строка
      Status: 'CONFIRMED',
      Amount: 150000,
      Token: 'abc',
    });
    expect(ev.orderNumber).toBe('2026-000123');
    expect(ev.paymentId).toBe('900000001');
    expect(ev.status).toBe('CONFIRMED');
    expect(ev.amountKop).toBe(150000);
    expect(ev.token).toBe('abc');
  });

  it('невалидный объект → null-поля', () => {
    const ev = parseNotification(null);
    expect(ev.paymentId).toBeNull();
    expect(ev.status).toBeNull();
  });

  it('sanitizeNotification убирает Token/Pan/CardId', () => {
    const clean = sanitizeNotification({
      OrderId: 'x',
      Token: 'secret',
      Pan: '4300********0777',
      CardId: '12345',
      Status: 'NEW',
    });
    expect(clean).toEqual({ OrderId: 'x', Status: 'NEW' });
  });
});

describe('tbank/service — handleWebhook проверка Token', () => {
  it('невалидный Token → verified:false, событие НЕ записывается', async () => {
    const body = signedBody({ Status: 'CONFIRMED' });
    body.Token = 'tampered';
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(false);
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('подмена суммы после подписи ломает Token (anti-tamper)', async () => {
    const body = signedBody({ Status: 'CONFIRMED' });
    body.Amount = 1;
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(false);
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });
});

describe('tbank/service — handleWebhook маппинг и идемпотентность', () => {
  it('валидный CONFIRMED → recordWebhookEvent(nextStatus=paid), processed:true', async () => {
    const body = signedBody({ Status: 'CONFIRMED' });
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.processed).toBe(true);
    expect(res.paymentStatus).toBe('paid');
    expect(recordWebhookEventMock).toHaveBeenCalledTimes(1);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as {
      log: { orderId: string };
      nextStatus: string | null;
      comment: string;
    };
    expect(arg.nextStatus).toBe('paid');
    expect(arg.comment).toContain('tbank-webhook:CONFIRMED');
    expect(arg.log.orderId).toBe('order-uuid-1');
  });

  it('дубликат (recordWebhookEvent inserted:false) → duplicate:true, processed:false, paymentStatus:null', async () => {
    recordWebhookEventMock.mockResolvedValue({ inserted: false, processed: false });
    const body = signedBody({ Status: 'CONFIRMED' });
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.processed).toBe(false);
    expect(res.paymentStatus).toBeNull();
  });

  it('повторная доставка того же события безопасна (идемпотентность)', async () => {
    const body = signedBody({ Status: 'CONFIRMED' });
    // Первая доставка — новое событие.
    recordWebhookEventMock.mockResolvedValueOnce({ inserted: true, processed: true });
    const first = await service().handleWebhook(body);
    expect(first.processed).toBe(true);
    expect(first.duplicate).toBe(false);
    // Вторая доставка — ON CONFLICT DO NOTHING → дубликат.
    recordWebhookEventMock.mockResolvedValueOnce({ inserted: false, processed: false });
    const second = await service().handleWebhook(body);
    expect(second.duplicate).toBe(true);
    expect(second.processed).toBe(false);
    expect(recordWebhookEventMock).toHaveBeenCalledTimes(2);
  });

  it('REJECTED → recordWebhookEvent(nextStatus=failed)', async () => {
    const body = signedBody({ Status: 'REJECTED' });
    const res = await service().handleWebhook(body);
    expect(res.paymentStatus).toBe('failed');
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string | null };
    expect(arg.nextStatus).toBe('failed');
  });

  it('заказ не найден → verified:true, processed:false, recordWebhookEvent НЕ вызвана', async () => {
    getOrderByNumberMock.mockResolvedValue(null);
    const body = signedBody({ Status: 'CONFIRMED' });
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(true);
    expect(res.processed).toBe(false);
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });

  it('неизвестный Status (нет маппинга) → recordWebhookEvent(nextStatus=null), processed:false', async () => {
    recordWebhookEventMock.mockResolvedValue({ inserted: true, processed: false });
    const body = signedBody({ Status: 'SOME_FUTURE_STATUS' });
    const res = await service().handleWebhook(body);
    expect(res.verified).toBe(true);
    expect(res.paymentStatus).toBeNull();
    expect(res.processed).toBe(false);
    expect(res.duplicate).toBe(false);
    // Событие всё равно записано (аудит) с nextStatus null.
    expect(recordWebhookEventMock).toHaveBeenCalledTimes(1);
    const arg = recordWebhookEventMock.mock.calls[0]![0] as { nextStatus: string | null };
    expect(arg.nextStatus).toBeNull();
  });
});
