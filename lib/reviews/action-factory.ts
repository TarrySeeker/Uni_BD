/**
 * Фабрика Server Actions среза «Отзывы» (docs/24 §4) — АДМИН-модерация.
 *
 * Вынесена из lib/reviews/actions.ts ('use server'), т.к. такой модуль может
 * экспортировать ТОЛЬКО async-функции, а здесь живут: фабрика createReviewActions
 * (синхронная, возвращает объект действий), типы зависимостей, дефолтные
 * прод-зависимости (productionReviewDeps) и вспомогательные не-async функции.
 * actions.ts тонко оборачивает прод-экземпляр (эталон lib/settings/action-factory).
 *
 * Submit с витрины идёт отдельным storefront-роутом, НЕ через эти actions.
 *
 * Все мутации — через единый пайплайн defineAction (§4.7 ядра): guard (reviews.write)
 * → Zod → handler (модуль-гейт reviews + БД, параметризовано) → revalidate → audit
 * ('review.*'). Доменные ошибки — ReviewError (errors.ts).
 *
 * i18n: переводим ТОЛЬКО reply (whitelist REVIEW_TRANSLATABLE_FIELDS). UGC (body/
 * author_name) НЕ переводим. reply санитайзится (strip→plain) для базы и каждого
 * языка оверлея — защита от stored-XSS даже при компрометации админ-аккаунта.
 *
 * Тестируемость без БД/Next: createReviewActions(deps) инъецирует репозиторий и
 * пайплайн; прод-обёртки — productionReviewDeps().
 */

import {
  defineAction,
  defaultDeps,
  PublicActionError,
  type ActionCtx,
  type ActionDeps,
} from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import {
  getLocaleConfig,
  resolveTranslationsUpdate,
  type LocaleConfig,
  type TranslationsMap,
} from '@/lib/i18n';

import { REVIEW_TRANSLATABLE_FIELDS } from './fields';
import { ReviewError } from './errors';
import { canReviewTransition, reviewStatusLabel } from './status';
import { sanitizeReviewBody } from './sanitize';
import {
  ReviewStatusInputSchema,
  ReviewReplyInputSchema,
  ReviewIdSchema,
} from './schemas';
import {
  getReviewById,
  updateReviewStatus,
  setReviewReply,
  deleteReview,
} from './repository';
import type { Review, ReviewStatus } from './types';

/** Путь раздела «Отзывы» для инвалидации после мутации. */
const REVIEWS_PATH = '/admin/reviews';
function reviewPath(id: string): string {
  return `/admin/reviews/${id}`;
}

/** Санитизирует reply внутри оверлея переводов (каждый язык). Иммутабельно. */
function sanitizeTranslationsReply(map: TranslationsMap): TranslationsMap {
  const out: TranslationsMap = {};
  for (const [locale, fields] of Object.entries(map)) {
    if (!fields || typeof fields !== 'object') {
      out[locale] = fields;
      continue;
    }
    const inner = { ...(fields as Record<string, unknown>) };
    if (typeof inner.reply === 'string') {
      inner.reply = sanitizeReviewBody(inner.reply);
    }
    out[locale] = inner as Record<string, unknown>;
  }
  return out;
}

/** Зависимости фабрики review-actions (инъекция для тестов без БД). */
export interface ReviewActionDeps {
  actionDeps: ActionDeps;
  isReviewsEnabled: () => Promise<boolean>;
  getLocaleConfig: () => Promise<LocaleConfig>;
  getReviewById: (id: string) => Promise<Review | null>;
  updateReviewStatus: (
    id: string,
    status: ReviewStatus,
    moderatedBy: string | null,
  ) => Promise<Review | null>;
  setReviewReply: (
    id: string,
    reply: string | null,
    translations: TranslationsMap,
    moderatedBy: string | null,
  ) => Promise<Review | null>;
  deleteReview: (id: string) => Promise<{ id: string } | null>;
}

/** Прод-зависимости (реальная БД + дефолтный пайплайн). */
export function productionReviewDeps(): ReviewActionDeps {
  return {
    actionDeps: defaultDeps,
    isReviewsEnabled: () => isModuleEffectivelyEnabled('reviews'),
    getLocaleConfig,
    getReviewById,
    updateReviewStatus,
    setReviewReply,
    deleteReview,
  };
}

/** Собирает набор review-actions поверх инъецированных зависимостей. */
export function createReviewActions(deps: ReviewActionDeps) {
  const { actionDeps } = deps;

  async function assertReviewsEnabled(): Promise<void> {
    if (!(await deps.isReviewsEnabled())) {
      throw new ReviewError('module_disabled', 'Модуль «Отзывы» выключен.');
    }
  }

  /** Смена статуса отзыва (модерация): approve/reject/вернуть в очередь. */
  const setReviewStatus = defineAction({
    permission: 'reviews.write',
    input: ReviewStatusInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      await assertReviewsEnabled();

      const before = await deps.getReviewById(data.id);
      if (!before) {
        throw new ReviewError('not_found', 'Отзыв не найден.');
      }
      const target = data.status as ReviewStatus;
      // X→X запрещён (нулевой переход) — модерация в тот же статус бессмысленна
      // (машина статусов, docs/24 §4; образец leads canLeadTransition).
      if (!canReviewTransition(before.status, target)) {
        throw new PublicActionError('errors.reviewsAction.invalidTransition', {
          from: reviewStatusLabel(before.status),
          to: reviewStatusLabel(target),
        });
      }

      const after = await deps.updateReviewStatus(data.id, target, ctx.user.id);
      if (!after) {
        throw new ReviewError('not_found', 'Отзыв не найден.');
      }

      return {
        result: { id: data.id, status: target },
        revalidate: [REVIEWS_PATH, reviewPath(data.id)],
        audit: {
          action: 'review.status.change',
          entityType: 'review',
          entityId: data.id,
          before: { status: before.status },
          after: { status: target },
        },
      };
    },
  });

  /** Ответ магазина на отзыв (reply + переводы reply). */
  const replyToReview = defineAction({
    permission: 'reviews.write',
    input: ReviewReplyInputSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      await assertReviewsEnabled();

      const before = await deps.getReviewById(data.id);
      if (!before) {
        throw new ReviewError('not_found', 'Отзыв не найден.');
      }

      // Оверлей reply: whitelist × не-дефолтные языки; provided=false → не трогаем.
      const localeConfig = await deps.getLocaleConfig();
      const tr = resolveTranslationsUpdate(
        REVIEW_TRANSLATABLE_FIELDS,
        data.translations,
        before.translations,
        localeConfig,
      );
      const safeTranslations = tr.provided
        ? sanitizeTranslationsReply(tr.value)
        : tr.value;

      // Базовый reply санитайзится (strip→plain). undefined → не трогаем; null → очистка.
      const baseReply =
        data.reply === undefined
          ? before.reply
          : data.reply === null
            ? null
            : sanitizeReviewBody(data.reply) || null;

      const after = await deps.setReviewReply(
        data.id,
        baseReply,
        safeTranslations,
        ctx.user.id,
      );
      if (!after) {
        throw new ReviewError('not_found', 'Отзыв не найден.');
      }

      return {
        result: { id: data.id },
        revalidate: [REVIEWS_PATH, reviewPath(data.id)],
        audit: {
          action: 'review.reply',
          entityType: 'review',
          entityId: data.id,
          before: { reply: before.reply },
          after: { reply: baseReply },
        },
      };
    },
  });

  /** Удаление отзыва (необратимо). */
  const removeReview = defineAction({
    permission: 'reviews.write',
    input: ReviewIdSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertReviewsEnabled();
      const removed = await deps.deleteReview(data.id);
      if (!removed) {
        throw new ReviewError('not_found', 'Отзыв не найден.');
      }
      return {
        result: { id: data.id },
        revalidate: [REVIEWS_PATH],
        audit: {
          action: 'review.delete',
          entityType: 'review',
          entityId: data.id,
        },
      };
    },
  });

  return { setReviewStatus, replyToReview, deleteReview: removeReview };
}

export { PublicActionError };
