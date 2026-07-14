/**
 * Репозиторий подарочных сертификатов (docs/24 §5).
 *
 * Разделение ответственности:
 *  - мапперы row→domain (снейк→camel, remaining вычисляется balance.ts);
 *  - чтения для админки (список/карточка/леджер) и погашения (findByCode/getBalance);
 *  - ТРАНЗАКЦИОННЫЕ ПРИМИТИВЫ денег (redeemGiftTx/releaseGiftTx) — атомарны под
 *    SELECT ... FOR UPDATE + guarded UPDATE + идемпотентный INSERT леджера.
 *
 * ГРАНИЦА 4a: примитивы реализованы и покрыты тестами, но в конвейер
 * quote/createOrder/refund (lib/orders) НЕ подключены — интеграция это 4b.
 * Здесь только домен + схема + админка.
 *
 * Параметризованный sql (postgres.js), деньги — строки NUMERIC (арифметика
 * остатка/лимитов — на стороне БД в guarded UPDATE, точно и без гонок).
 */
import type { TransactionSql } from 'postgres';

import { sql } from '@/lib/db/client';
import type { TranslationsMap } from '@/lib/i18n';

import { certRemaining } from './balance';
import { GiftOverspendError, GiftCertificateError } from './errors';
import type {
  GiftCertificate,
  GiftCertificateRedemption,
  GiftCertificateStatus,
} from './types';

// -----------------------------------------------------------------------------
// Мапперы row → domain.
// -----------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function toNullableDate(v: unknown): Date | null {
  return v == null ? null : toDate(v);
}

/** Строка gift_certificates → домен (remaining вычисляется). */
export function mapGiftCertificate(row: Record<string, unknown>): GiftCertificate {
  const initialAmount = String(row.initial_amount);
  const spentTotal = String(row.spent_total);
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name ?? ''),
    description: row.description != null ? String(row.description) : null,
    terms: row.terms != null ? String(row.terms) : null,
    initialAmount,
    spentTotal,
    remaining: certRemaining({ initialAmount, spentTotal }),
    currency: String(row.currency ?? 'RUB'),
    status: row.status as GiftCertificateStatus,
    validUntil: toNullableDate(row.valid_until),
    translations: (row.translations ?? {}) as TranslationsMap,
    comment: String(row.comment ?? ''),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** Строка gift_certificate_redemptions → домен. */
export function mapRedemption(row: Record<string, unknown>): GiftCertificateRedemption {
  return {
    id: String(row.id),
    certificateId: String(row.certificate_id),
    orderId: String(row.order_id),
    amount: String(row.amount),
    reversedAt: toNullableDate(row.reversed_at),
    createdAt: toDate(row.created_at),
  };
}

/**
 * Список колонок сертификата как sql-фрагмент. ФУНКЦИЯ (не top-level константа):
 * `sql\`...\`` дёргает ленивый клиент БД, а вычисление на этапе импорта модуля
 * упало бы без DATABASE_URL (юнит-окружение). Вызывается только внутри запросов,
 * когда соединение уже нужно.
 */
function giftCols() {
  return sql`
    id, code, name, description, terms, initial_amount, spent_total, currency,
    status, valid_until, translations, comment, created_at, updated_at
  `;
}

// -----------------------------------------------------------------------------
// Чтения (админка + погашение).
// -----------------------------------------------------------------------------

/** Сертификат по коду (регистронезависимо — citext). null — не найден. */
export async function findByCode(code: string): Promise<GiftCertificate | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${giftCols()} FROM gift_certificates WHERE code = ${code} LIMIT 1
  `;
  return rows[0] ? mapGiftCertificate(rows[0]) : null;
}

/** Сертификат по id. null — не найден. */
export async function getGiftCertificateById(id: string): Promise<GiftCertificate | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${giftCols()} FROM gift_certificates WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapGiftCertificate(rows[0]) : null;
}

/** Остаток сертификата (initial − spent) как строка NUMERIC. null — не найден. */
export async function getBalance(certificateId: string): Promise<string | null> {
  const rows = await sql<{ initial_amount: string; spent_total: string }[]>`
    SELECT initial_amount, spent_total FROM gift_certificates WHERE id = ${certificateId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return certRemaining({ initialAmount: row.initial_amount, spentTotal: row.spent_total });
}

/** Список сертификатов (новые сверху) для админки. */
export async function listGiftCertificates(limit = 200): Promise<GiftCertificate[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${giftCols()} FROM gift_certificates ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map(mapGiftCertificate);
}

/** Общее число сертификатов (для «Всего: N» и плашки усечения). */
export async function countGiftCertificates(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM gift_certificates`;
  return Number(rows[0]?.count ?? 0);
}

/** Леджер списаний сертификата (для истории в карточке). */
export async function getRedemptions(certificateId: string): Promise<GiftCertificateRedemption[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, certificate_id, order_id, amount, reversed_at, created_at
    FROM gift_certificate_redemptions
    WHERE certificate_id = ${certificateId}
    ORDER BY created_at DESC, id
  `;
  return rows.map(mapRedemption);
}

// -----------------------------------------------------------------------------
// Запись (выпуск / обновление / статус) — админка.
// -----------------------------------------------------------------------------

/** Параметры выпуска сертификата (нормализованы схемой/сервисом). */
export interface IssueGiftCertificateRow {
  code: string;
  name: string;
  initialAmount: string;
  validUntil: Date | null;
  description: string | null;
  terms: string | null;
  comment: string;
  translations: TranslationsMap;
}

/** Вставляет сертификат, возвращает домен. Уникальность кода — на UNIQUE-индексе. */
export async function insertGiftCertificate(input: IssueGiftCertificateRow): Promise<GiftCertificate> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO gift_certificates (
      code, name, description, terms, initial_amount, valid_until, comment, translations
    ) VALUES (
      ${input.code}, ${input.name}, ${input.description}, ${input.terms},
      ${input.initialAmount}, ${input.validUntil}, ${input.comment}, ${sql.json(input.translations as Record<string, never>)}
    )
    RETURNING ${giftCols()}
  `;
  return mapGiftCertificate(rows[0]!);
}

/** Меняет статус (active/disabled — деактивация/реактивация). true — строка найдена. */
export async function updateGiftStatus(id: string, status: GiftCertificateStatus): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE gift_certificates
       SET status = ${status}, updated_at = now()
     WHERE id = ${id}
     RETURNING id
  `;
  return rows.length > 0;
}

// -----------------------------------------------------------------------------
// Транзакционные ПРИМИТИВЫ денег (атомарны под FOR UPDATE + guarded UPDATE).
// -----------------------------------------------------------------------------

/** Результат погашения части номинала. */
export interface RedeemResult {
  /** Списание применено в этом вызове (баланс декрементирован). */
  applied: boolean;
  /** Заказ уже был погашен ранее (идемпотентность UNIQUE(cert,order)) — баланс не тронут. */
  alreadyRedeemed: boolean;
  /** Сумма списания (строка NUMERIC). */
  amount: string;
  /** Остаток после операции (строка NUMERIC). */
  remaining: string;
}

/**
 * АТОМАРНОЕ погашение части номинала на заказ НА ПЕРЕДАННОЙ транзакции `tx`
 * (без собственного begin — вызывается внутри транзакции createOrder в 4b, а в
 * тестах — из redeemGift/собственной sql.begin). Порядок (анти-TOCTOU):
 *   1) SELECT ... FOR UPDATE — блокируем строку сертификата на время транзакции;
 *   2) валидация (существует / active / не истёк / остаток >= amount);
 *   3) INSERT леджера ON CONFLICT (certificate_id, order_id) DO NOTHING —
 *      идемпотентность: повторный сабмит заказа НЕ декрементит дважды;
 *   4) guarded UPDATE spent_total += amount WHERE spent_total+amount <= initial_amount
 *      RETURNING — гонка/оверспенд → count!==1 → GiftOverspendError (откат);
 *   5) status → 'depleted', когда остаток обнулился.
 * Возврат alreadyRedeemed=true (без декремента), если строка леджера уже была.
 */
export async function redeemGiftTx(
  tx: TransactionSql,
  input: { certificateId: string; orderId: string; amount: string },
): Promise<RedeemResult> {
  const { certificateId, orderId, amount } = input;

  const locked = await tx<
    { initial_amount: string; spent_total: string; status: GiftCertificateStatus; valid_until: Date | null }[]
  >`
    SELECT initial_amount, spent_total, status, valid_until
    FROM gift_certificates
    WHERE id = ${certificateId}
    FOR UPDATE
  `;
  const cert = locked[0];
  if (!cert) {
    throw new GiftCertificateError('not_found', 'Подарочный сертификат не найден.');
  }
  if (cert.status === 'disabled') {
    throw new GiftCertificateError('disabled', 'Подарочный сертификат отключён.');
  }
  if (cert.status !== 'active') {
    throw new GiftCertificateError('inactive', 'Подарочный сертификат недоступен к списанию.');
  }
  if (cert.valid_until != null && new Date(cert.valid_until).getTime() <= Date.now()) {
    throw new GiftCertificateError('expired', 'Срок действия подарочного сертификата истёк.');
  }

  // Идемпотентная вставка леджера: повтор того же заказа не декрементит баланс.
  const ledger = await tx<{ id: string }[]>`
    INSERT INTO gift_certificate_redemptions (certificate_id, order_id, amount)
    VALUES (${certificateId}, ${orderId}, ${amount})
    ON CONFLICT (certificate_id, order_id) DO NOTHING
    RETURNING id
  `;
  if (ledger.length === 0) {
    // Заказ уже был погашен: баланс НЕ трогаем (идемпотентность). Отдаём текущий остаток.
    const cur = await tx<{ remaining: string }[]>`
      SELECT (initial_amount - spent_total)::text AS remaining
      FROM gift_certificates WHERE id = ${certificateId}
    `;
    return { applied: false, alreadyRedeemed: true, amount, remaining: cur[0]!.remaining };
  }

  // Guarded UPDATE: декремент только если не выйдем за номинал (анти-оверспенд/гонка).
  const updated = await tx<{ remaining: string }[]>`
    UPDATE gift_certificates
       SET spent_total = spent_total + ${amount},
           status = CASE WHEN spent_total + ${amount} >= initial_amount THEN 'depleted' ELSE status END,
           updated_at = now()
     WHERE id = ${certificateId}
       AND spent_total + ${amount} <= initial_amount
    RETURNING (initial_amount - spent_total)::text AS remaining
  `;
  if (updated.count !== 1) {
    // Остатка не хватило (или гонка) — откатываем всю транзакцию, включая INSERT леджера.
    throw new GiftOverspendError();
  }

  return { applied: true, alreadyRedeemed: false, amount, remaining: updated[0]!.remaining };
}

/** Результат возврата (рефанда) списаний по заказу. */
export interface ReleaseResult {
  /** Число реверснутых строк леджера в этом вызове (0 — уже возвращено / нечего). */
  reversedCount: number;
  /** Суммарно возвращено на баланс (строка NUMERIC). */
  reversedAmount: string;
}

/**
 * АТОМАРНЫЙ возврат баланса по заказу (рефанд) на переданной `tx`. Для каждого
 * активного списания заказа (reversed_at IS NULL): метит reversed_at и возвращает
 * amount в spent_total (spent_total -= amount), снимая 'depleted' → 'active', если
 * остаток снова > 0. Идемпотентно: повторный вызов не находит активных строк → no-op.
 *
 * Хук под settleRefundEffectsTx (4b): при refunded/cancelled заказ восстанавливает
 * баланс сертификата.
 */
export async function releaseGiftTx(
  tx: TransactionSql,
  input: { orderId: string },
): Promise<ReleaseResult> {
  const { orderId } = input;

  // Блокируем активные списания заказа (обычно 0..1 — один сертификат на заказ).
  const rows = await tx<{ id: string; certificate_id: string; amount: string }[]>`
    SELECT id, certificate_id, amount
    FROM gift_certificate_redemptions
    WHERE order_id = ${orderId} AND reversed_at IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) {
    return { reversedCount: 0, reversedAmount: '0.00' };
  }

  let reversedMinorSum = 0;
  let reversedCount = 0;
  for (const r of rows) {
    // Guard-идемпотентность: метим только ещё не реверснутую строку.
    const marked = await tx<{ id: string }[]>`
      UPDATE gift_certificate_redemptions
         SET reversed_at = now()
       WHERE id = ${r.id} AND reversed_at IS NULL
      RETURNING id
    `;
    if (marked.count !== 1) continue;
    await tx`
      UPDATE gift_certificates
         SET spent_total = spent_total - ${r.amount},
             status = CASE
                        WHEN status = 'depleted' AND (spent_total - ${r.amount}) < initial_amount
                          THEN 'active'
                        ELSE status
                      END,
             updated_at = now()
       WHERE id = ${r.certificate_id}
    `;
    reversedCount += 1;
    reversedMinorSum += Math.round(Number(r.amount) * 100);
  }

  const whole = Math.trunc(reversedMinorSum / 100);
  const frac = reversedMinorSum % 100;
  return { reversedCount, reversedAmount: `${whole}.${String(frac).padStart(2, '0')}` };
}

/**
 * Обёртка redeemGiftTx с собственной транзакцией (standalone-использование/тесты).
 * В проде декремент делается ВНУТРИ транзакции createOrder (4b), а не отдельно.
 */
export async function redeemGift(input: {
  certificateId: string;
  orderId: string;
  amount: string;
}): Promise<RedeemResult> {
  return sql.begin((tx: TransactionSql) => redeemGiftTx(tx, input));
}

/** Обёртка releaseGiftTx с собственной транзакцией (standalone/тесты). */
export async function releaseGift(input: { orderId: string }): Promise<ReleaseResult> {
  return sql.begin((tx: TransactionSql) => releaseGiftTx(tx, input));
}
