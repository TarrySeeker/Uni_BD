/**
 * /api/storefront/v1/reviews — публичные отзывы товара (docs/24 §4).
 *
 * GET  ?productId=<uuid>&page=&pageSize=&locale=
 *      → { data: { items, aggregate }, pagination }. ТОЛЬКО status='approved'
 *      (фильтр в SQL — pending/rejected на витрину не попадают). reply локализован
 *      по ctx.locale. productId не-uuid → 400.
 * POST { productId, authorName, body, rating, email? }
 *      → submit отзыва. SECURITY: САНИТИЗАЦИЯ body (strip→plain), rate-limit
 *      (конвейер runStorefront), валидный существующий productId (иначе 404),
 *      статус ФОРСИТСЯ pending (репозиторий), customer резолвится по email из
 *      справочника (гость → null; чужого customer подделать нельзя). Клиент НЕ
 *      может выставить status/is_verified/customerId — их нет в схеме.
 *
 * Гейт module:'reviews' ОБЯЗАТЕЛЕН (выключен → 404). CORS: GET+POST.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import {
  toPublicReviewDto,
  toReviewAggregateDto,
} from '@/lib/storefront/review-dto';
import {
  listApprovedByProduct,
  getProductRatingAggregate,
  productExists,
  findCustomerIdByEmail,
  insertReview,
} from '@/lib/reviews/repository';
import { ReviewSubmitSchema } from '@/lib/reviews/schemas';
import { sanitizeReviewBody } from '@/lib/reviews/sanitize';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/** Грубая проверка UUID (до обращения к БД) — иначе 400 bad_request. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIntOr(v: string | null, def: number): number {
  if (v === null) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async (ctx) => {
      const { cors } = ctx;
      const loc = localizeCtxFrom(ctx);
      const q = new URL(req.url).searchParams;

      const productId = q.get('productId')?.trim() ?? '';
      if (!UUID_RE.test(productId)) {
        return jsonError('bad_request', 'Нужен корректный productId (uuid).', cors);
      }

      const page = Math.max(1, parseIntOr(q.get('page'), 1));
      const pageSize = Math.min(50, Math.max(1, parseIntOr(q.get('pageSize'), 10)));
      const offset = (page - 1) * pageSize;

      const [{ rows, total }, aggregate] = await Promise.all([
        listApprovedByProduct(productId, { limit: pageSize, offset }),
        getProductRatingAggregate(productId),
      ]);

      const items = rows.map((r) => toPublicReviewDto(r, loc));

      return jsonData(
        { items, aggregate: toReviewAggregateDto(aggregate) },
        { pagination: { total, page, pageSize, count: items.length } },
        cors,
      );
    },
    { module: 'reviews', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = ReviewSubmitSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля отзыва.', cors);
      }

      // Валидный существующий товар — иначе дружелюбный 404 (FK бы дал 500).
      if (!(await productExists(parsed.data.productId))) {
        return jsonError('not_found', 'Товар не найден.', cors);
      }

      // Санитизация UGC-текста (strip HTML → plain) — анти-XSS. Пусто → 422.
      const safeBody = sanitizeReviewBody(parsed.data.body);
      if (!safeBody) {
        return jsonError('unprocessable', 'Текст отзыва пуст.', cors);
      }
      const authorName = sanitizeReviewBody(parsed.data.authorName);
      if (!authorName) {
        return jsonError('unprocessable', 'Укажите имя автора.', cors);
      }

      // customer резолвится по email ТОЛЬКО из справочника (гость → null). Чужого
      // покупателя подделать нельзя — id из тела не принимается.
      const customerId = parsed.data.email
        ? await findCustomerIdByEmail(parsed.data.email)
        : null;

      try {
        // insertReview ВСЕГДА пишет status='pending' (anti-tamper на уровне SQL).
        const { id, status } = await insertReview({
          productId: parsed.data.productId,
          customerId,
          authorName,
          body: safeBody,
          rating: parsed.data.rating,
          source: 'storefront',
        });
        return jsonData({ id, status }, {}, cors, { status: 201 });
      } catch (err) {
        logger.error('review submit: не удалось сохранить отзыв', {
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { module: 'reviews', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
