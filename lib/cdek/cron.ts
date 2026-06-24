/**
 * Cron-воркеры СДЭК (docs/08 §9, порт console/controllers/CdekController:
 * actionCreatePending / actionNotifyStuck / actionSyncOrder).
 *
 * Реализованы как ЧИСТАЯ, ТЕСТИРУЕМАЯ логика: каждый воркер принимает
 * инъецируемые зависимости (deps) — поиск кандидатов в БД и вызовы сервисов
 * СДЭК. По умолчанию deps берут реальные функции (sql + OrderService/
 * TrackingService), но в тестах подменяются моками, поэтому воркер-логика
 * проверяется без живой БД и сети (ОКРУЖЕНИЕ без БД, ADR-004).
 *
 * Гарантии каждого воркера:
 *   • идемпотентность — повторный прогон не дублирует (createShipment
 *     пропускает заказы с уже выставленным cdek_uuid; см. lib/cdek/services/
 *     order.ts);
 *   • устойчивость — ошибка по одному заказу не валит весь прогон (try/catch
 *     на каждый элемент, статистика failed);
 *   • безопасность — no-op при выключенном модуле cdek или при
 *     CDEK_CREATE_ENABLED=false (только для авто-создания).
 *
 * Зона: lib/cdek/cron.ts. Переиспользует lib/cdek/services/{order,tracking},
 * lib/cdek/config.ts. lib/orders / lib/cdek/services не правятся (только импорт).
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import { getCdekConfig, type CdekConfig } from './config';
import { OrderService } from './services/order';
import { TrackingService } from './services/tracking';

/** Максимум попыток авто-создания (порт BOrder::CDEK_MAX_RETRIES). */
export const CDEK_MAX_RETRIES = 3;

/** Лимит заказов на один прогон create-pending (порт LIMIT 100). */
export const CREATE_PENDING_LIMIT = 100;

/** Кандидат на создание отправления (минимум полей для воркера). */
export interface PendingOrderCandidate {
  id: string;
  number: string;
}

/** Кандидат на обновление статуса (активное, не финальное отправление). */
export interface ActiveShipmentCandidate {
  orderId: string;
  cdekUuid: string;
}

/** Зависший заказ (для нотификации администратора). */
export interface StuckOrderCandidate {
  id: string;
  number: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  error: string | null;
}

// =============================================================================
// Статистика прогонов.
// =============================================================================

export interface CreatePendingStats {
  created: number;
  failed: number;
  skipped: number;
  /**
   * true, если прогон НЕ выполнился, потому что advisory-lock уже держит другой
   * (параллельный/перекрывшийся) прогон. Прогон при этом — безопасный no-op.
   */
  lockSkipped: boolean;
}

/**
 * Результат попытки взять advisory-lock и выполнить критическую секцию.
 * acquired=false → секция НЕ выполнялась (лок занят другим процессом).
 */
export type WithLockResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Берёт транзакционный advisory-lock (pg_try_advisory_xact_lock) по стабильному
 * ключу и выполняет fn ПОД ЛОКОМ в той же транзакции. Лок держится до конца
 * транзакции (xact-lock), поэтому критическая секция гарантированно одна на
 * процесс/кластер. Не получили лок → { acquired: false } без выполнения fn.
 */
export type WithLock = <T>(key: string, fn: () => Promise<T>) => Promise<WithLockResult<T>>;

/**
 * Дефолтная реализация withLock через sql.begin + pg_try_advisory_xact_lock.
 * hashtext(key) → int4-ключ для advisory-lock (детерминированный на ключ).
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<WithLockResult<T>> {
  return await sql.begin<WithLockResult<T>>(async (tx: TransactionSql) => {
    const rows = await tx<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked
    `;
    if (rows[0]?.locked !== true) {
      return { acquired: false };
    }
    const result = await fn();
    return { acquired: true, result };
  });
}

export interface RefreshActiveStats {
  refreshed: number;
  transitioned: number;
  failed: number;
}

export interface NotifyStuckStats {
  stuck: number;
}

// =============================================================================
// Дефолтные DB-зависимые поисковики кандидатов (порт SQL из CdekController).
// Изолированы, чтобы тесты могли подменить их моком (без живой БД).
// =============================================================================

/**
 * Оплаченные заказы без отправления СДЭК (порт actionCreatePending SQL):
 *   payment_status='paid' (или статус продвинут), cdek_uuid IS NULL, не pickup,
 *   создан за последние 24ч, ещё нет отправления с исчерпанным retry_count.
 * LEFT JOIN cdek_shipments — отбрасываем заказы, по которым уже есть запись с
 * retry_count >= MAX (kill, как в carre). LIMIT 100, ORDER BY created_at.
 */
export async function findPendingOrders(
  limit: number = CREATE_PENDING_LIMIT,
): Promise<PendingOrderCandidate[]> {
  const rows = await sql<Array<{ id: string; number: string }>>`
    SELECT o.id, o.number
      FROM orders o
      LEFT JOIN cdek_shipments s ON s.order_id = o.id
     WHERE o.cdek_uuid IS NULL
       AND o.delivery_type <> 'pickup'
       AND o.created_at > now() - interval '24 hours'
       AND (
         o.payment_status = 'paid'
         OR o.status IN ('paid', 'packed', 'shipped', 'delivered', 'completed')
       )
       AND (s.id IS NULL OR (s.cdek_uuid IS NULL AND s.retry_count < ${CDEK_MAX_RETRIES}))
     ORDER BY o.created_at
     LIMIT ${limit}
  `;
  return rows.map((r) => ({ id: String(r.id), number: String(r.number) }));
}

/**
 * Активные (не финальные) отправления для pull-обновления статуса (порт
 * sync-stale): есть cdek_uuid, delivery_status ещё не финальный
 * (delivered/returned/cancelled). LIMIT для безопасности прогона.
 */
export async function findActiveShipments(
  limit: number = CREATE_PENDING_LIMIT,
): Promise<ActiveShipmentCandidate[]> {
  const rows = await sql<Array<{ order_id: string; cdek_uuid: string }>>`
    SELECT s.order_id, s.cdek_uuid
      FROM cdek_shipments s
      JOIN orders o ON o.id = s.order_id
     WHERE s.cdek_uuid IS NOT NULL
       AND o.delivery_status NOT IN ('delivered', 'returned', 'cancelled')
     ORDER BY s.updated_at
     LIMIT ${limit}
  `;
  return rows.map((r) => ({ orderId: String(r.order_id), cdekUuid: String(r.cdek_uuid) }));
}

/**
 * Зависшие заказы (порт actionNotifyStuck SQL): оплачены, без cdek_uuid,
 * retry_count >= MAX, за последние 7 дней. Для одного админ-уведомления.
 */
export async function findStuckOrders(): Promise<StuckOrderCandidate[]> {
  const rows = await sql<
    Array<{
      id: string;
      number: string;
      customer_name: string;
      customer_phone: string | null;
      customer_email: string | null;
      error: string | null;
    }>
  >`
    SELECT o.id, o.number, o.customer_name, o.customer_phone, o.customer_email,
           LEFT(s.error, 255) AS error
      FROM orders o
      JOIN cdek_shipments s ON s.order_id = o.id
     WHERE o.cdek_uuid IS NULL
       AND s.cdek_uuid IS NULL
       AND s.retry_count >= ${CDEK_MAX_RETRIES}
       AND o.created_at > now() - interval '7 days'
       AND (
         o.payment_status = 'paid'
         OR o.status IN ('paid', 'packed', 'shipped', 'delivered', 'completed')
       )
     ORDER BY o.created_at
  `;
  return rows.map((r) => ({
    id: String(r.id),
    number: String(r.number),
    customerName: String(r.customer_name),
    customerPhone: r.customer_phone ?? null,
    customerEmail: r.customer_email ?? null,
    error: r.error ?? null,
  }));
}

// =============================================================================
// Инъецируемые зависимости воркеров (для тестов).
// =============================================================================

export interface CreatePendingDeps {
  config: CdekConfig;
  findCandidates: (limit?: number) => Promise<PendingOrderCandidate[]>;
  /** Создание отправления по заказу (идемпотентно, см. OrderService). */
  createShipment: (orderId: string) => Promise<{ cdekUuid: string | null }>;
  /**
   * Сериализатор прогона: берёт advisory-lock по ключу и выполняет критическую
   * секцию под ним. По умолчанию — withAdvisoryLock (sql + pg_try_advisory_xact_lock).
   */
  withLock: WithLock;
}

export interface RefreshActiveDeps {
  config: CdekConfig;
  findCandidates: (limit?: number) => Promise<ActiveShipmentCandidate[]>;
  refreshStatus: (orderId: string) => Promise<{ transitioned: boolean }>;
}

export interface NotifyStuckDeps {
  config: CdekConfig;
  findCandidates: () => Promise<StuckOrderCandidate[]>;
  /** Hook уведомления администратора (email опц.; по умолчанию — лог). */
  notify: (orders: readonly StuckOrderCandidate[]) => Promise<void>;
}

function defaultCreatePendingDeps(): CreatePendingDeps {
  const orderService = new OrderService();
  return {
    config: getCdekConfig(),
    findCandidates: findPendingOrders,
    createShipment: async (orderId) => {
      const sh = await orderService.createShipment(orderId);
      return { cdekUuid: sh.cdekUuid };
    },
    withLock: withAdvisoryLock,
  };
}

function defaultRefreshActiveDeps(): RefreshActiveDeps {
  const tracking = new TrackingService();
  return {
    config: getCdekConfig(),
    findCandidates: findActiveShipments,
    refreshStatus: async (orderId) => {
      const r = await tracking.refreshStatus(orderId);
      return { transitioned: r.transitioned };
    },
  };
}

/**
 * Hook уведомления о зависших (docs/08 §8.5): фактическая отправка email
 * зависит от почтового модуля Admik (его пока нет) — оставляем лог-заглушку.
 * Заменяется в deps, когда появится mailer.
 */
async function defaultNotifyStuck(orders: readonly StuckOrderCandidate[]): Promise<void> {
  console.warn(
    `[cdek/notify-stuck] ${orders.length} заказ(ов) без накладной (retry >= ${CDEK_MAX_RETRIES}): ` +
      orders.map((o) => `#${o.number}`).join(', '),
  );
}

function defaultNotifyStuckDeps(): NotifyStuckDeps {
  return {
    config: getCdekConfig(),
    findCandidates: findStuckOrders,
    notify: defaultNotifyStuck,
  };
}

// =============================================================================
// Воркеры.
// =============================================================================

/** Стабильный ключ advisory-lock для сериализации прогонов create-pending. */
export const CREATE_PENDING_LOCK_KEY = 'cdek-create-pending';

/**
 * create-pending (каждые 5 мин): создаёт отправления для оплаченных заказов без
 * СДЭК. No-op при CDEK_CREATE_ENABLED=false (kill-switch). Ошибка по одному
 * заказу инкрементит failed, но не валит прогон. Идемпотентность обеспечивает
 * OrderService.createShipment (пропуск заказа с уже выставленным cdek_uuid →
 * учитывается как skipped).
 *
 * АНТИ-ГОНКА (data-integrity). Внешний шедулер может сработать дважды или
 * 5-минутный тик может перекрыться (медленный прогон). Без сериализации два
 * прогона выбирают одни и те же кандидаты (findPendingOrders НЕ помечает их) и
 * оба POST-ят в СДЭК → дубль накладной. Фикс: ВЕСЬ прогон выполняется под
 * транзакционным advisory-lock (pg_try_advisory_xact_lock(hashtext(
 * 'cdek-create-pending'))). Не получили лок (другой прогон уже идёт) → выходим
 * как lockSkipped=true, НЕ читая кандидатов и НЕ делая удалённых вызовов. Лок
 * держится до конца транзакции, значит критическая секция гарантированно одна.
 * Дополнительно per-order лок в OrderService.createShipment страхует от гонки с
 * ручным созданием из админки.
 */
export async function runCreatePending(
  deps: CreatePendingDeps = defaultCreatePendingDeps(),
): Promise<CreatePendingStats> {
  if (!deps.config.createEnabled) {
    // Kill-switch: лок не берём (удалённых вызовов не будет). Считаем кандидатов
    // пропущенными (прогон безопасен и идемпотентен).
    const candidates = await deps.findCandidates(CREATE_PENDING_LIMIT);
    return { created: 0, failed: 0, skipped: candidates.length, lockSkipped: false };
  }

  // Сериализация прогона: критическая секция — под advisory-lock.
  const locked = await deps.withLock(CREATE_PENDING_LOCK_KEY, async () => {
    const stats: CreatePendingStats = {
      created: 0,
      failed: 0,
      skipped: 0,
      lockSkipped: false,
    };
    const candidates = await deps.findCandidates(CREATE_PENDING_LIMIT);
    for (const cand of candidates) {
      try {
        const sh = await deps.createShipment(cand.id);
        if (sh.cdekUuid) {
          stats.created += 1;
        } else {
          // Отправление создано без uuid (например ошибка СДЭК записана в error) —
          // считаем пропущенным, не падаем.
          stats.skipped += 1;
        }
      } catch {
        stats.failed += 1;
      }
    }
    return stats;
  });

  if (!locked.acquired) {
    // Параллельный/перекрывшийся прогон уже держит лок — этот прогон — no-op.
    return { created: 0, failed: 0, skipped: 0, lockSkipped: true };
  }
  return locked.result;
}

/**
 * refresh-active (каждый час): pull-обновление статусов активных отправлений
 * (фоллбэк, если webhook не пришёл). Ошибка по одному заказу не валит прогон.
 */
export async function runRefreshActive(
  deps: RefreshActiveDeps = defaultRefreshActiveDeps(),
): Promise<RefreshActiveStats> {
  const stats: RefreshActiveStats = { refreshed: 0, transitioned: 0, failed: 0 };

  const candidates = await deps.findCandidates(CREATE_PENDING_LIMIT);
  for (const cand of candidates) {
    try {
      const r = await deps.refreshStatus(cand.orderId);
      stats.refreshed += 1;
      if (r.transitioned) {
        stats.transitioned += 1;
      }
    } catch {
      stats.failed += 1;
    }
  }

  return stats;
}

/**
 * notify-stuck (ежедневно 10:00): находит зависшие заказы (retry исчерпан, без
 * накладной) и вызывает hook уведомления (email опц., по умолчанию лог). Ничего
 * не делает при пустом списке. Идемпотентен (только читает + нотифицирует).
 */
export async function runNotifyStuck(
  deps: NotifyStuckDeps = defaultNotifyStuckDeps(),
): Promise<NotifyStuckStats> {
  const candidates = await deps.findCandidates();
  if (candidates.length > 0) {
    await deps.notify(candidates);
  }
  return { stuck: candidates.length };
}
