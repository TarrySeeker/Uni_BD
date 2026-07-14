/**
 * Слой чтения/записи отзывов (docs/24 §4).
 *
 * Только параметризованный `sql` (tagged templates → анти-SQLi). Витрина зовёт
 * insertReview (submit) + listApprovedByProduct + getProductRatingAggregate;
 * админка — listReviewsForModeration/countReviews/updateReviewStatus/setReviewReply/
 * deleteReview (через actions.ts). Маппинг row→domain — в чистых функциях map,
 * экспортируемых для юнит-тестов (БД не нужна). Образец lib/news/repository.ts.
 *
 * ANTI-TAMPER: insertReview ВСЕГДА пишет status='pending' (колонка не принимается
 * из вызова) — клиент не может создать сразу approved. translations тянется сырым;
 * резолв reply по locale — на границе (storefront review-dto / admin-форма).
 */

import { sql } from '@/lib/db/client';
import type { TranslationsMap } from '@/lib/i18n';

import type {
  ApprovedReviewRow,
  Review,
  ReviewAggregate,
  ReviewModerationRow,
  ReviewStatus,
} from './types';

// =============================================================================
// Чистые мапперы row→domain (тестируемы без БД).
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function asNullableDate(v: unknown): Date | null {
  return v == null ? null : asDate(v);
}

/** Сырой jsonb-оверлей → TranslationsMap. Не-объект/массив/NULL → {}. */
function asTranslations(v: unknown): TranslationsMap {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as TranslationsMap;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as TranslationsMap)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Маппер строки reviews → доменный Review. */
export function mapReview(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    customerId: row.customer_id != null ? String(row.customer_id) : null,
    authorName: String(row.author_name),
    body: String(row.body),
    rating: Number(row.rating),
    status: row.status as ReviewStatus,
    reply: row.reply != null ? String(row.reply) : null,
    isVerified: Boolean(row.is_verified),
    source: String(row.source ?? 'storefront'),
    translations: asTranslations(row.translations),
    createdAt: asDate(row.created_at),
    publishedAt: asNullableDate(row.published_at),
    moderatedAt: asNullableDate(row.moderated_at),
    moderatedBy: row.moderated_by != null ? String(row.moderated_by) : null,
  };
}

/** Маппер строки модерации (Review + денормализованные поля товара из JOIN). */
export function mapReviewModerationRow(
  row: Record<string, unknown>,
): ReviewModerationRow {
  return {
    ...mapReview(row),
    productName: row.product_name != null ? String(row.product_name) : null,
    productSlug: row.product_slug != null ? String(row.product_slug) : null,
  };
}

/** Маппер витринной строки одобренного отзыва. */
export function mapApprovedReviewRow(
  row: Record<string, unknown>,
): ApprovedReviewRow {
  return {
    id: String(row.id),
    authorName: String(row.author_name),
    body: String(row.body),
    rating: Number(row.rating),
    reply: row.reply != null ? String(row.reply) : null,
    translations: asTranslations(row.translations),
    createdAt: asDate(row.created_at),
    publishedAt: asNullableDate(row.published_at),
  };
}

// =============================================================================
// Запись — submit с витрины.
// =============================================================================

/** Поля вставки отзыва (нормализованы схемой/санитайзером в роуте). */
export interface InsertReviewInput {
  productId: string;
  customerId: string | null;
  authorName: string;
  body: string;
  rating: number;
  source?: string;
}

/**
 * Вставляет отзыв. СТАТУС ВСЕГДА 'pending' — колонка захардкожена в VALUES, клиент
 * НЕ может создать approved (anti-tamper). is_verified остаётся дефолтным false.
 * Возвращает id и status. FK product_id обеспечивает существование товара на уровне
 * БД (нарушение → 23503, роут проверяет заранее для дружелюбного 404).
 */
export async function insertReview(
  input: InsertReviewInput,
): Promise<{ id: string; status: ReviewStatus }> {
  const rows = await sql<{ id: string; status: ReviewStatus }[]>`
    INSERT INTO reviews (
      product_id, customer_id, author_name, body, rating, source, status
    ) VALUES (
      ${input.productId}, ${input.customerId}, ${input.authorName},
      ${input.body}, ${input.rating}, ${input.source ?? 'storefront'}, 'pending'
    )
    RETURNING id, status
  `;
  return { id: rows[0]!.id, status: rows[0]!.status };
}

/** true, если товар с таким id существует (для дружелюбного 404 на submit). */
export async function productExists(productId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM products WHERE id = ${productId} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Резолвит id существующего покупателя по email (citext, регистронезависимо).
 * НЕ создаёт нового покупателя — гость остаётся с customer_id=null. Нельзя
 * «подделать» чужого customer: привязка только по совпадению email в справочнике.
 */
export async function findCustomerIdByEmail(
  email: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM customers WHERE email = ${email} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// =============================================================================
// Чтения — витрина (только approved).
// =============================================================================

/**
 * Витринный список ОДОБРЕННЫХ отзывов по товару (пагинация). Только status='approved'
 * (фильтр в SQL — pending/rejected на витрину не попадают). Свежие одобренные выше.
 */
export async function listApprovedByProduct(
  productId: string,
  opts: { limit: number; offset: number },
): Promise<{ rows: ApprovedReviewRow[]; total: number }> {
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit)));
  const offset = Math.max(0, Math.floor(opts.offset));

  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, author_name, body, rating, reply, translations, created_at, published_at
    FROM reviews
    WHERE product_id = ${productId} AND status = 'approved'
    ORDER BY published_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM reviews
    WHERE product_id = ${productId} AND status = 'approved'
  `;

  return {
    rows: rows.map(mapApprovedReviewRow),
    total: Number(totalRows[0]?.count ?? 0),
  };
}

/**
 * Агрегат рейтинга товара — ТОЛЬКО по approved (FILTER исключает pending/rejected).
 * average=0 и все счётчики=0, если одобренных отзывов нет.
 */
export async function getProductRatingAggregate(
  productId: string,
): Promise<ReviewAggregate> {
  const rows = await sql<
    {
      average: string | null;
      count: string;
      r1: string;
      r2: string;
      r3: string;
      r4: string;
      r5: string;
    }[]
  >`
    SELECT
      AVG(rating) FILTER (WHERE status = 'approved')                 AS average,
      count(*)    FILTER (WHERE status = 'approved')::text           AS count,
      count(*)    FILTER (WHERE status = 'approved' AND rating = 1)::text AS r1,
      count(*)    FILTER (WHERE status = 'approved' AND rating = 2)::text AS r2,
      count(*)    FILTER (WHERE status = 'approved' AND rating = 3)::text AS r3,
      count(*)    FILTER (WHERE status = 'approved' AND rating = 4)::text AS r4,
      count(*)    FILTER (WHERE status = 'approved' AND rating = 5)::text AS r5
    FROM reviews
    WHERE product_id = ${productId}
  `;
  const row = rows[0];
  return {
    average: row?.average != null ? Number(row.average) : 0,
    count: Number(row?.count ?? 0),
    distribution: {
      1: Number(row?.r1 ?? 0),
      2: Number(row?.r2 ?? 0),
      3: Number(row?.r3 ?? 0),
      4: Number(row?.r4 ?? 0),
      5: Number(row?.r5 ?? 0),
    },
  };
}

// =============================================================================
// Чтения — админ-модерация.
// =============================================================================

export interface ReviewModerationFilter {
  status?: ReviewStatus;
  page: number;
  pageSize: number;
}

/**
 * Список отзывов для модерации с фильтром статуса + пагинацией. JOIN products —
 * чтобы показать товар. Ожидающие приоритетно (pending выше), затем свежие.
 */
export async function listReviewsForModeration(
  f: ReviewModerationFilter,
): Promise<{ rows: ReviewModerationRow[]; total: number }> {
  const page = Math.max(1, Math.floor(f.page));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize)));
  const offset = (page - 1) * pageSize;

  const where = sql`
    WHERE (${f.status ?? null}::text IS NULL OR r.status = ${f.status ?? null})
  `;

  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      r.id, r.product_id, r.customer_id, r.author_name, r.body, r.rating, r.status,
      r.reply, r.is_verified, r.source, r.translations, r.created_at, r.published_at,
      r.moderated_at, r.moderated_by,
      p.name AS product_name, p.slug AS product_slug
    FROM reviews r
    LEFT JOIN products p ON p.id = r.product_id
    ${where}
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const totalRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM reviews r ${where}
  `;

  return {
    rows: rows.map(mapReviewModerationRow),
    total: Number(totalRows[0]?.count ?? 0),
  };
}

/** Общее число отзывов (все статусы) — для «Всего: N». */
export async function countReviews(): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM reviews
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Число отзывов в заданном статусе (например, pending — для бейджа очереди). */
export async function countReviewsByStatus(
  status: ReviewStatus,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM reviews WHERE status = ${status}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Полный отзыв по id (для карточки модерации/before-снимка). null — не найден. */
export async function getReviewById(id: string): Promise<Review | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, product_id, customer_id, author_name, body, rating, status, reply,
           is_verified, source, translations, created_at, published_at,
           moderated_at, moderated_by
    FROM reviews WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapReview(rows[0]) : null;
}

/**
 * Смена статуса отзыва (модерация). При переходе в approved — published_at=
 * COALESCE(published_at, now()) (первое одобрение проставляет метку публикации).
 * moderated_at/moderated_by пишутся всегда. Возвращает обновлённый отзыв или null.
 */
export async function updateReviewStatus(
  id: string,
  status: ReviewStatus,
  moderatedBy: string | null,
): Promise<Review | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE reviews SET
      status       = ${status},
      published_at = CASE WHEN ${status} = 'approved'
                          THEN COALESCE(published_at, now()) ELSE published_at END,
      moderated_at = now(),
      moderated_by = ${moderatedBy}
    WHERE id = ${id}
    RETURNING id, product_id, customer_id, author_name, body, rating, status, reply,
              is_verified, source, translations, created_at, published_at,
              moderated_at, moderated_by
  `;
  return rows[0] ? mapReview(rows[0]) : null;
}

/**
 * Устанавливает ответ магазина (reply) + оверлей переводов reply. reply=null очищает
 * базовый ответ. translations пишется целиком (résolu в actions через
 * resolveTranslationsUpdate). Возвращает обновлённый отзыв или null.
 */
export async function setReviewReply(
  id: string,
  reply: string | null,
  translations: TranslationsMap,
  moderatedBy: string | null,
): Promise<Review | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE reviews SET
      reply        = ${reply},
      translations = ${sql.json(translations as Record<string, never>)},
      moderated_by = ${moderatedBy}
    WHERE id = ${id}
    RETURNING id, product_id, customer_id, author_name, body, rating, status, reply,
              is_verified, source, translations, created_at, published_at,
              moderated_at, moderated_by
  `;
  return rows[0] ? mapReview(rows[0]) : null;
}

/** Удаляет отзыв. Возвращает {id} или null (не найден). */
export async function deleteReview(
  id: string,
): Promise<{ id: string } | null> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM reviews WHERE id = ${id} RETURNING id
  `;
  return rows[0] ?? null;
}
