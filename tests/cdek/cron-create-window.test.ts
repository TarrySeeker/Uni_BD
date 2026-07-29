import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * АУДИТ major #17: заказ, оплаченный позже 24ч, НИКОГДА не получал накладную.
 *
 * Было: выборка кандидатов на создание отправления жёстко фильтровала
 * `o.created_at > now() - interval '24 hours'`. Заказ, оплаченный на вторые
 * сутки (банковский перевод, COD-подтверждение, сутки простоя крона), выпадал
 * из окна НАВСЕГДА — крон его больше не видел. Вторая страховка молчала:
 * findStuckOrders требует JOIN cdek_shipments + retry_count >= MAX, т.е. заказ
 * БЕЗ ЕДИНОЙ попытки в «зависшие» не попадал тоже.
 *
 * Стало:
 *   • окно — настраиваемое (CDEK_CREATE_WINDOW_HOURS, дефолт 720ч = 30 суток);
 *   • якорь окна — МОМЕНТ ОПЛАТЫ (coalesce(paid_at, created_at)), а не создания:
 *     именно оплата запускает жизненный цикл накладной;
 *   • «зависшие» находятся и БЕЗ единой попытки (LEFT JOIN), с отдельным
 *     признаком — оператор видит их явно;
 *   • ВЫБОРКА ОСТАЁТСЯ ОГРАНИЧЕННОЙ: 288 легаси-заказов магазина, переехавшего
 *     с историей, не должны хлынуть в СДЭК (прошлая сессия уже обжигалась на
 *     уборщике неоплаченных заказов). Окно конечно и LIMIT сохраняется.
 */

import {
  resolveCreateWindowHours,
  CDEK_CREATE_WINDOW_HOURS_DEFAULT,
  CDEK_STUCK_WINDOW_HOURS_DEFAULT,
  buildPendingOrdersQuery,
  buildStuckOrdersQuery,
  runNotifyStuck,
  CDEK_MAX_RETRIES,
  type NotifyStuckDeps,
  type StuckOrderCandidate,
} from '@/lib/cdek/cron';
import { getCdekConfig } from '@/lib/cdek/config';

// ---------------------------------------------------------------------------
// Окно как настройка (мультитенантность: без хардкода под конкретный магазин).
// ---------------------------------------------------------------------------

describe('#17 окно создания накладной — настраиваемое, с безопасным дефолтом', () => {
  it('дефолт заметно больше суток (оплата на вторые сутки не теряется)', () => {
    expect(CDEK_CREATE_WINDOW_HOURS_DEFAULT).toBeGreaterThan(24);
    // Конечное окно, а не «вся история»: легаси-заказы не хлынут в СДЭК.
    expect(Number.isFinite(CDEK_CREATE_WINDOW_HOURS_DEFAULT)).toBe(true);
  });

  it('env CDEK_CREATE_WINDOW_HOURS переопределяет окно (настройка магазина)', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_WINDOW_HOURS: '48' });
    expect(cfg.createWindowHours).toBe(48);
  });

  it('env не задан → дефолт из константы', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test' });
    expect(cfg.createWindowHours).toBe(CDEK_CREATE_WINDOW_HOURS_DEFAULT);
  });

  it('resolveCreateWindowHours: нечисловое/отрицательное/ноль → дефолт (не «вся история»)', () => {
    expect(resolveCreateWindowHours(undefined)).toBe(CDEK_CREATE_WINDOW_HOURS_DEFAULT);
    expect(resolveCreateWindowHours(0)).toBe(CDEK_CREATE_WINDOW_HOURS_DEFAULT);
    expect(resolveCreateWindowHours(-5)).toBe(CDEK_CREATE_WINDOW_HOURS_DEFAULT);
    expect(resolveCreateWindowHours(Number.NaN)).toBe(CDEK_CREATE_WINDOW_HOURS_DEFAULT);
  });

  it('resolveCreateWindowHours: валидное значение проходит как есть', () => {
    expect(resolveCreateWindowHours(48)).toBe(48);
    expect(resolveCreateWindowHours(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Форма SQL: якорь окна — оплата, а не создание.
// ---------------------------------------------------------------------------

describe('#17 выборка кандидатов — якорь окна по МОМЕНТУ ОПЛАТЫ', () => {
  const q = buildPendingOrdersQuery(720);

  it('окно считается от coalesce(paid_at, created_at), а не только от created_at', () => {
    expect(q).toMatch(/coalesce\(\s*o\.paid_at\s*,\s*o\.created_at\s*\)/i);
  });

  it('жёсткого «created_at > now() - interval \'24 hours\'» больше нет', () => {
    expect(q).not.toMatch(/o\.created_at\s*>\s*now\(\)\s*-\s*interval\s*'24 hours'/i);
  });

  it('окно подставляется параметром (настройка), а не зашитой константой', () => {
    expect(buildPendingOrdersQuery(48)).toMatch(/48 hours/);
    expect(buildPendingOrdersQuery(720)).toMatch(/720 hours/);
  });

  it('БЕЗОПАСНОСТЬ ЛЕГАСИ: выборка остаётся ограниченной окном (не вся история)', () => {
    expect(q).toMatch(/interval/i);
    expect(q).toMatch(/LIMIT/i);
  });

  it('прежние условия сохранены: без cdek_uuid, не pickup, оплачен, retry < MAX', () => {
    expect(q).toMatch(/o\.cdek_uuid IS NULL/i);
    expect(q).toMatch(/delivery_type <> 'pickup'/i);
    expect(q).toMatch(/payment_status = 'paid'/i);
    expect(q).toMatch(/retry_count </i);
  });
});

// ---------------------------------------------------------------------------
// Зависшие: видны и БЕЗ единой попытки.
// ---------------------------------------------------------------------------

describe('#17 «зависшие» заказы — видны и без единой попытки', () => {
  const q = buildStuckOrdersQuery(CDEK_STUCK_WINDOW_HOURS_DEFAULT);

  it('LEFT JOIN вместо JOIN: заказ без записи cdek_shipments не теряется', () => {
    expect(q).toMatch(/LEFT JOIN\s+cdek_shipments/i);
    expect(q).not.toMatch(/(?<!LEFT )\bJOIN\s+cdek_shipments/i);
  });

  it('в выборку попадают ОБА случая: retry исчерпан ИЛИ попыток не было вовсе', () => {
    expect(q).toMatch(/s\.id IS NULL/i);
    expect(q).toMatch(/retry_count >=/i);
  });

  it('окно «зависших» покрывает окно создания (иначе заказ выпадет из обоих)', () => {
    expect(CDEK_STUCK_WINDOW_HOURS_DEFAULT).toBeGreaterThanOrEqual(
      CDEK_CREATE_WINDOW_HOURS_DEFAULT,
    );
  });

  it('окно «зависших» — параметр, а не зашитые 7 дней', () => {
    expect(buildStuckOrdersQuery(48)).toMatch(/48 hours/);
    expect(buildStuckOrdersQuery(720)).toMatch(/720 hours/);
  });
});

// ---------------------------------------------------------------------------
// Нотификация: заказ без попыток должен быть ЯВНО виден.
// ---------------------------------------------------------------------------

function stuckCand(patch: Partial<StuckOrderCandidate> = {}): StuckOrderCandidate {
  return {
    id: 'ord-1',
    number: 'TC-1',
    customerName: 'Иван',
    customerPhone: null,
    customerEmail: null,
    error: null,
    retryCount: 0,
    attempted: false,
    ...patch,
  };
}

describe('#17 runNotifyStuck — заказ без единой попытки виден оператору', () => {
  const cfg = getCdekConfig({ NODE_ENV: 'test' });

  it('кандидат без попыток попадает в нотификацию (stuck считается)', async () => {
    const notify = vi.fn(async (_o: readonly StuckOrderCandidate[]) => {});
    const deps: NotifyStuckDeps = {
      config: cfg,
      findCandidates: vi.fn(async () => [stuckCand({ attempted: false })]),
      notify,
    };
    const stats = await runNotifyStuck(deps);
    expect(stats.stuck).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0][0]!.attempted).toBe(false);
  });

  it('РЕГРЕССИЯ: пустой список → notify не вызывается', async () => {
    const notify = vi.fn(async (_o: readonly StuckOrderCandidate[]) => {});
    const stats = await runNotifyStuck({ config: cfg, findCandidates: vi.fn(async () => []), notify });
    expect(stats.stuck).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Лог-заглушка нотификации: должна различать «попыток не было» и «retry исчерпан».
// ---------------------------------------------------------------------------

describe('#17 defaultNotifyStuck — в логе различимы «без попыток» и «retry исчерпан»', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('в сообщении есть обе группы и номера заказов', async () => {
    const { defaultNotifyStuck } = await import('@/lib/cdek/cron');
    await defaultNotifyStuck([
      stuckCand({ id: 'a', number: 'TC-A', attempted: false, retryCount: 0 }),
      stuckCand({ id: 'b', number: 'TC-B', attempted: true, retryCount: CDEK_MAX_RETRIES }),
    ]);
    const msg = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(msg).toContain('TC-A');
    expect(msg).toContain('TC-B');
    // Заказ без попыток — отдельный, более тревожный класс (крон его не трогал).
    expect(msg).toMatch(/без\s+(единой\s+)?попыт/i);
    // …и это ОТДЕЛЬНАЯ строка лога, а не общий список вперемешку с исчерпанными.
    expect(warn.mock.calls.length).toBe(2);
  });
});
