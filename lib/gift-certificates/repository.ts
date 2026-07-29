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

import type { OrderStatus, PaymentStatus } from '@/lib/orders/types';

import { certRemaining } from './balance';
import { GiftOverspendError, GiftCertificateError } from './errors';
import type { CertificateSourceItem } from './origin';
import type {
  GiftCertificate,
  GiftCertificateRedemption,
  GiftCertificateStatus,
  GiftIssueSource,
  GiftParty,
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

function toStrOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Снимок стороны сделки из строки с префиксом колонок (purchaser_/recipient_).
 * Чистая функция — покрыта юнитом без БД.
 */
export function mapGiftParty(row: Record<string, unknown>, prefix: 'purchaser' | 'recipient'): GiftParty {
  return {
    name: toStrOrNull(row[`${prefix}_name`]),
    email: toStrOrNull(row[`${prefix}_email`]),
    phone: toStrOrNull(row[`${prefix}_phone`]),
  };
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
    purchaser: mapGiftParty(row, 'purchaser'),
    purchaserCustomerId: row.purchaser_customer_id != null ? String(row.purchaser_customer_id) : null,
    recipient: mapGiftParty(row, 'recipient'),
    issuedOrderId: row.issued_order_id != null ? String(row.issued_order_id) : null,
    issuedOrderItemId: row.issued_order_item_id != null ? String(row.issued_order_item_id) : null,
    issueSource: row.issue_source != null ? (String(row.issue_source) as GiftIssueSource) : null,
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
    status, valid_until, translations, comment,
    purchaser_name, purchaser_email, purchaser_phone, purchaser_customer_id,
    recipient_name, recipient_email, recipient_phone,
    issued_order_id, issued_order_item_id, issue_source,
    created_at, updated_at
  `;
}

/**
 * Тот же список колонок для запросов, которые строятся вне этого модуля
 * (RETURNING в actions.updateGiftFieldsDb). Единый источник — giftCols():
 * новая колонка не может появиться в одном месте и пропасть в другом.
 */
export function giftColumnsFragment() {
  return giftCols();
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
  /** Снимок «кто купил» (ТЗ п.7); по умолчанию пустой. */
  purchaser?: GiftParty;
  /** Связь покупателя с учёткой клиента; гость → null. */
  purchaserCustomerId?: string | null;
  /** Снимок «на чьё имя» (ТЗ п.7). */
  recipient?: GiftParty;
  /** Происхождение выпуска (заказ/позиция); ручной выпуск → null. */
  issuedOrderId?: string | null;
  issuedOrderItemId?: string | null;
  issueSource?: GiftIssueSource;
}

/**
 * Вставляет сертификат, возвращает домен. Уникальность кода — на UNIQUE-индексе
 * 0039; уникальность выпуска по позиции заказа — на ЧАСТИЧНОМ UNIQUE 0054
 * (повторный выпуск по той же позиции → 23505, обрабатывается в actions).
 */
export async function insertGiftCertificate(input: IssueGiftCertificateRow): Promise<GiftCertificate> {
  const purchaser = input.purchaser ?? { name: null, email: null, phone: null };
  const recipient = input.recipient ?? { name: null, email: null, phone: null };
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO gift_certificates (
      code, name, description, terms, initial_amount, valid_until, comment, translations,
      purchaser_name, purchaser_email, purchaser_phone, purchaser_customer_id,
      recipient_name, recipient_email, recipient_phone,
      issued_order_id, issued_order_item_id, issue_source
    ) VALUES (
      ${input.code}, ${input.name}, ${input.description}, ${input.terms},
      ${input.initialAmount}, ${input.validUntil}, ${input.comment}, ${sql.json(input.translations as Record<string, never>)},
      ${purchaser.name}, ${purchaser.email}, ${purchaser.phone}, ${input.purchaserCustomerId ?? null},
      ${recipient.name}, ${recipient.email}, ${recipient.phone},
      ${input.issuedOrderId ?? null}, ${input.issuedOrderItemId ?? null}, ${input.issueSource ?? 'manual'}
    )
    RETURNING ${giftCols()}
  `;
  return mapGiftCertificate(rows[0]!);
}

/** Сертификаты, ВЫПУЩЕННЫЕ по заказу (блок в карточке заказа). */
export async function listGiftCertificatesIssuedForOrder(orderId: string): Promise<GiftCertificate[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${giftCols()} FROM gift_certificates
    WHERE issued_order_id = ${orderId}
    ORDER BY created_at DESC, id
  `;
  return rows.map(mapGiftCertificate);
}

/** Источник выпуска: заказ + его позиция (снимок) — для issueGiftFromOrder. */
export interface GiftIssueSourceRow {
  orderId: string;
  orderNumber: string;
  currency: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /**
   * Статусы и момент оплаты заказа — КАЛИТКА ручного выпуска (находка аудита
   * №27) и база отсчёта срока действия кода. До их появления ручной путь не мог
   * отличить оплаченный заказ от отменённого и выпускал деньги по любому.
   */
  paymentStatus: PaymentStatus;
  status: OrderStatus;
  paidAt: Date | null;
  /** Сертификат, которым оплачен САМ заказ (0041); не путать с issued_order_id. */
  giftCertificateId: string | null;
  item: CertificateSourceItem;
}

/**
 * Читает позицию заказа вместе с заголовком (покупатель — из ДЕНОРМАЛИЗОВАННЫХ
 * полей заказа: гостевой чекаут не имеет customers-строки). null — позиция не
 * найдена или принадлежит другому заказу (защита от подмены orderId в форме).
 */
export async function getOrderItemForGiftIssue(
  orderId: string,
  orderItemId: string,
): Promise<GiftIssueSourceRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT o.id            AS order_id,
           o.number        AS order_number,
           o.currency      AS currency,
           o.status, o.payment_status, o.paid_at, o.gift_certificate_id,
           o.customer_id, o.customer_name, o.customer_email, o.customer_phone,
           i.id            AS item_id,
           i.name_snapshot, i.sku_snapshot, i.attributes_snapshot,
           i.unit_price, i.quantity, i.line_total
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
    WHERE i.id = ${orderItemId} AND i.order_id = ${orderId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    orderId: String(row.order_id),
    orderNumber: String(row.order_number),
    currency: String(row.currency ?? 'RUB'),
    customerId: row.customer_id != null ? String(row.customer_id) : null,
    customerName: String(row.customer_name ?? ''),
    customerEmail: String(row.customer_email ?? ''),
    customerPhone: String(row.customer_phone ?? ''),
    paymentStatus: String(row.payment_status) as PaymentStatus,
    status: String(row.status) as OrderStatus,
    paidAt: toNullableDate(row.paid_at),
    giftCertificateId: row.gift_certificate_id != null ? String(row.gift_certificate_id) : null,
    item: {
      id: String(row.item_id),
      nameSnapshot: String(row.name_snapshot ?? ''),
      skuSnapshot: String(row.sku_snapshot ?? ''),
      attributesSnapshot: (row.attributes_snapshot ?? {}) as Record<string, unknown>,
      unitPrice: String(row.unit_price),
      quantity: Number(row.quantity ?? 1),
      lineTotal: String(row.line_total),
    },
  };
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

// -----------------------------------------------------------------------------
// Автовыпуск сертификатов по оплаченному заказу (ТЗ владельца п.11).
// -----------------------------------------------------------------------------

/** Заказ + его позиции-снимки: всё, что нужно решить «выпускать ли и на сколько». */
export interface AutoIssueOrderSnapshot {
  orderId: string;
  orderNumber: string;
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** Момент оплаты — ЕДИНСТВЕННАЯ база отсчёта срока действия кода. */
  paidAt: Date | null;
  /** Сертификат, которым оплачен САМ заказ (0041). Не путать с issued_order_id. */
  giftCertificateId: string | null;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: CertificateSourceItem[];
}

/** Заказ + позиции для автовыпуска. null — заказа нет. */
export async function getOrderForAutoIssue(orderId: string): Promise<AutoIssueOrderSnapshot | null> {
  const orders = await sql<Record<string, unknown>[]>`
    SELECT id, number, currency, status, payment_status, paid_at, gift_certificate_id,
           customer_id, customer_name, customer_email, customer_phone
    FROM orders WHERE id = ${orderId} LIMIT 1
  `;
  const o = orders[0];
  if (!o) return null;

  const items = await sql<Record<string, unknown>[]>`
    SELECT id, name_snapshot, sku_snapshot, attributes_snapshot, unit_price, quantity, line_total
    FROM order_items WHERE order_id = ${orderId} ORDER BY id
  `;

  return {
    orderId: String(o.id),
    orderNumber: String(o.number),
    currency: String(o.currency ?? 'RUB'),
    status: String(o.status) as OrderStatus,
    paymentStatus: String(o.payment_status) as PaymentStatus,
    paidAt: toNullableDate(o.paid_at),
    giftCertificateId: o.gift_certificate_id != null ? String(o.gift_certificate_id) : null,
    customerId: o.customer_id != null ? String(o.customer_id) : null,
    customerName: String(o.customer_name ?? ''),
    customerEmail: String(o.customer_email ?? ''),
    customerPhone: String(o.customer_phone ?? ''),
    items: items.map((row) => ({
      id: String(row.id),
      nameSnapshot: String(row.name_snapshot ?? ''),
      skuSnapshot: String(row.sku_snapshot ?? ''),
      attributesSnapshot: (row.attributes_snapshot ?? {}) as Record<string, unknown>,
      unitPrice: String(row.unit_price),
      quantity: Number(row.quantity ?? 1),
      lineTotal: String(row.line_total),
    })),
  };
}

/** Минимальная ссылка на выпущенный сертификат (без лишних полей в автопути). */
export interface IssuedGiftRef {
  id: string;
  code: string;
  initialAmount: string;
}

/**
 * Пространство advisory-локов автовыпуска (первый аргумент двухключевой формы).
 * Отдельное число, чтобы не пересечься с локами других подсистем.
 */
const GIFT_ISSUE_LOCK_NAMESPACE = 5401;

/**
 * Транзакционный advisory-лок по ЗАКАЗУ. Корректность дублей обеспечивает
 * частичный UNIQUE (issued_order_item_id); лок нужен лишь чтобы вебхук и
 * крон-догоняльщик не молотили конфликтующими транзакциями по одному заказу.
 * Снимается автоматически при commit/rollback (xact).
 */
export async function lockOrderForGiftIssueTx(tx: TransactionSql, orderId: string): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(${GIFT_ISSUE_LOCK_NAMESPACE}::int4, hashtext(${orderId}::text)::int4)
  `;
}

/**
 * INSERT сертификата на ПЕРЕДАННОЙ транзакции (одна транзакция на позицию).
 * Возвращает только id/code/номинал: автопуть не таскает полный документ.
 * Дубликаты (23505 по issued_order_item_id или по code) обрабатывает вызывающий.
 */
export async function insertGiftCertificateTx(
  tx: TransactionSql,
  input: IssueGiftCertificateRow,
): Promise<IssuedGiftRef> {
  const purchaser = input.purchaser ?? { name: null, email: null, phone: null };
  const recipient = input.recipient ?? { name: null, email: null, phone: null };
  const rows = await tx<{ id: string; code: string; initial_amount: string }[]>`
    INSERT INTO gift_certificates (
      code, name, description, terms, initial_amount, valid_until, comment, translations,
      purchaser_name, purchaser_email, purchaser_phone, purchaser_customer_id,
      recipient_name, recipient_email, recipient_phone,
      issued_order_id, issued_order_item_id, issue_source
    ) VALUES (
      ${input.code}, ${input.name}, ${input.description}, ${input.terms},
      ${input.initialAmount}, ${input.validUntil}, ${input.comment},
      ${tx.json(input.translations as Record<string, never>)},
      ${purchaser.name}, ${purchaser.email}, ${purchaser.phone}, ${input.purchaserCustomerId ?? null},
      ${recipient.name}, ${recipient.email}, ${recipient.phone},
      ${input.issuedOrderId ?? null}, ${input.issuedOrderItemId ?? null}, ${input.issueSource ?? 'auto'}
    )
    RETURNING id, code, initial_amount
  `;
  const row = rows[0]!;
  return { id: String(row.id), code: String(row.code), initialAmount: String(row.initial_amount) };
}

/** Погашенный при возврате код (для аудита и уведомления владельца). */
export interface RevokedGiftRef {
  id: string;
  code: string;
  initialAmount: string;
  spentTotal: string;
}

/** Результат гашения выпущенных по заказу кодов. */
export interface RevokeIssuedGiftsResult {
  revokedCount: number;
  revoked: RevokedGiftRef[];
}

/**
 * Гасит коды, ВЫПУЩЕННЫЕ по заказу, при его возврате/отмене (ТЗ п.11).
 *
 * Без этого возврат денег оставляет покупателю действующий сертификат на ту же
 * сумму — магазин платит дважды. Нового статуса 'revoked' не вводим: setGiftStatus
 * и CHECK 0039 знают active|disabled|depleted|expired, схему не трогаем.
 *
 * Идемпотентна: гасим только «живые» (active/depleted) — повторный вызов вернёт
 * 0 строк. depleted тоже гасим: остаток нулевой, но код мог бы «ожить» после
 * releaseGiftTx по другому заказу.
 */
export async function revokeIssuedGiftsTx(
  tx: TransactionSql,
  input: { orderId: string },
): Promise<RevokeIssuedGiftsResult> {
  const rows = await tx<Record<string, unknown>[]>`
    UPDATE gift_certificates
       SET status = 'disabled', updated_at = now()
     WHERE issued_order_id = ${input.orderId}
       AND status IN ('active','depleted')
    RETURNING id, code, initial_amount, spent_total
  `;
  const revoked = rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    initialAmount: String(r.initial_amount),
    spentTotal: String(r.spent_total),
  }));
  return { revokedCount: revoked.length, revoked };
}

/**
 * Помечает истёкшие сертификаты статусом 'expired' (минор аудита №3).
 *
 * Дефект информационный: деньги защищены явными проверками срока в
 * redeemGiftTx и assertRedeemable, но админка показывала истёкший код «Активен»,
 * хотя бейдж и локализованная подпись 'expired' уже существовали, а выставить
 * этот статус было НЕЧЕМ (крон знал одну задачу, а экшен допускал лишь
 * active↔disabled).
 *
 * Правило совпадает с чистым expiredGiftStatus (lib/gift-certificates/lifecycle):
 * трогаем ТОЛЬКО 'active' и 'depleted'. 'disabled' не трогаем — истечение срока
 * не должно снимать блокировку оператора; уже 'expired' не трогаем — идемпотентность.
 * Отсечка `now()` считается БД: в кластере часы приложения и БД могут разъехаться,
 * а деньги сравниваются по времени БД (redeemGiftTx).
 *
 * Возвращает число помеченных строк. Кодов не возвращает и не логирует.
 */
export async function markExpiredGiftCertificates(limit = 500): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE gift_certificates
       SET status = 'expired', updated_at = now()
     WHERE id IN (
       SELECT id FROM gift_certificates
        WHERE status IN ('active','depleted')
          AND valid_until IS NOT NULL
          AND valid_until <= now()
        ORDER BY valid_until
        LIMIT ${Math.max(1, Math.min(5000, Math.trunc(limit)))}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `;
  return rows.length;
}

/** Заказ-кандидат на догоняющий автовыпуск (для крона). */
export interface PendingGiftIssueOrder {
  orderId: string;
  orderNumber: string;
  paidAt: Date | null;
}

/**
 * Оплаченные заказы, у которых есть позиции БЕЗ выпущенного сертификата —
 * страховка на случай, если вебхук не довёз автовыпуск (сбой БД, рестарт).
 *
 * Окно 30 дней: старше — уже не «пропущенный выпуск», а история; без окна
 * выборка со временем деградирует. Фильтр «позиция похожа на сертификат» здесь
 * НЕ применяется (маркер лежит в jsonb-снимке) — отбор делает резолвер автопути,
 * поэтому в выдаче возможны заказы, по которым выпускать нечего.
 */
export async function findOrdersPendingGiftIssue(limit = 100): Promise<PendingGiftIssueOrder[]> {
  const rows = await sql<{ id: string; number: string; paid_at: Date | null }[]>`
    SELECT DISTINCT o.id, o.number, o.paid_at
    FROM orders o
    JOIN order_items i ON i.order_id = o.id
    LEFT JOIN gift_certificates g ON g.issued_order_item_id = i.id
    WHERE o.payment_status = 'paid'
      AND o.status NOT IN ('cancelled','refunded')
      AND o.paid_at > now() - interval '30 days'
      AND g.id IS NULL
    ORDER BY o.paid_at DESC
    LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}
  `;
  return rows.map((r) => ({
    orderId: String(r.id),
    orderNumber: String(r.number),
    paidAt: toNullableDate(r.paid_at),
  }));
}
