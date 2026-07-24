/**
 * Фабрика Server Actions среза «Новости» (docs/24 §3).
 *
 * Вынесена из lib/news/actions.ts ('use server'), т.к. такой модуль может
 * экспортировать ТОЛЬКО async-функции, а здесь живут: фабрика createNewsActions
 * (синхронная, возвращает объект действий), типы зависимостей, дефолтные
 * прод-зависимости (productionNewsDeps) и вспомогательные не-async функции.
 * actions.ts тонко оборачивает прод-экземпляр (см. эталон lib/settings/action-factory).
 *
 * Все мутации — через единый пайплайн defineAction (§4.7 ядра): guard (news.write)
 * → Zod → handler (модуль-гейт news + БД через sql, параметризовано) → revalidate →
 * audit ('news.*'). Доменные ошибки — через NewsError (errors.ts).
 *
 * Флаг модуля: КАЖДЫЙ handler начинается с assertNewsEnabled() — авторитетный
 * гейт (env ⊕ БД-оверрайд); при выключенном модуле бросает NewsError('module_disabled').
 *
 * i18n: title/excerpt/body/group + SEO/OG переводимы — блок translations резолвится
 * через resolveTranslationsUpdate (whitelist NEWS_TRANSLATABLE_FIELDS × включённые
 * языки), база (ru) пишется в обычные колонки. Rich-text body санитайзится и для
 * базы, и для каждого языка оверлея (анти-XSS, доверие клиенту запрещено).
 *
 * Тестируемость без БД/Next: createNewsActions(deps) инъецирует репозиторий и
 * пайплайн; прод-обёртки — productionNewsDeps().
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

import { NEWS_TRANSLATABLE_FIELDS } from './fields';
import { NewsError } from './errors';
import { canTransitionNews } from './status';
import { slugifyOrFallback, uniquifySlug } from './slug';
import { sanitizeHtml } from './sanitize';
import {
  NewsCreateSchema,
  NewsUpdateSchema,
  NewsIdSchema,
  NewsSetStatusSchema,
} from './schemas';
import {
  insertNews,
  updateNews,
  updateNewsStatus,
  deleteNews,
  getNewsById,
  type InsertNewsRow,
  type UpdateNewsRow,
} from './repository';
import type { NewsArticle, NewsStatus } from './types';

/** Пути инвалидации раздела «Новости». */
const NEWS_LIST_PATH = '/admin/news';
function newsPath(id: string): string {
  return `/admin/news/${id}`;
}

/** Код нарушения уникальности PostgreSQL (дубликат slug). */
const PG_UNIQUE_VIOLATION = '23505';
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Санитизирует rich-text `body` внутри оверлея переводов (каждый язык отдельно).
 * Остальные поля оверлея (заголовок/анонс/SEO) — простой текст, их не трогаем.
 * Возвращает НОВУЮ карту (иммутабельно).
 */
function sanitizeTranslationsBody(map: TranslationsMap): TranslationsMap {
  const out: TranslationsMap = {};
  for (const [locale, fields] of Object.entries(map)) {
    if (!fields || typeof fields !== 'object') {
      out[locale] = fields;
      continue;
    }
    const inner = { ...(fields as Record<string, unknown>) };
    if (typeof inner.body === 'string') {
      inner.body = sanitizeHtml(inner.body);
    }
    out[locale] = inner as Record<string, unknown>;
  }
  return out;
}

/** Зависимости фабрики news-actions (инъекция для тестов без БД). */
export interface NewsActionDeps {
  actionDeps: ActionDeps;
  isNewsEnabled: () => Promise<boolean>;
  getLocaleConfig: () => Promise<LocaleConfig>;
  insertNews: (row: InsertNewsRow) => Promise<{ id: string }>;
  updateNews: (row: UpdateNewsRow) => Promise<NewsArticle | null>;
  updateNewsStatus: (
    id: string,
    status: NewsStatus,
    updatedBy: string | null,
  ) => Promise<NewsArticle | null>;
  deleteNews: (id: string) => Promise<{ id: string; slug: string } | null>;
  getNewsById: (id: string) => Promise<NewsArticle | null>;
}

/** Прод-зависимости (реальная БД + дефолтный пайплайн). */
export function productionNewsDeps(): NewsActionDeps {
  return {
    actionDeps: defaultDeps,
    isNewsEnabled: () => isModuleEffectivelyEnabled('news'),
    getLocaleConfig,
    insertNews,
    updateNews,
    updateNewsStatus,
    deleteNews,
    getNewsById,
  };
}

/** Собирает набор news-actions поверх инъецированных зависимостей. */
export function createNewsActions(deps: NewsActionDeps) {
  const { actionDeps } = deps;

  async function assertNewsEnabled(): Promise<void> {
    if (!(await deps.isNewsEnabled())) {
      throw new NewsError('module_disabled', 'Модуль «Новости» выключен.');
    }
  }

  /** Вставка с ретраем slug при коллизии уникального индекса (образец cms). */
  async function insertWithUniqueSlug(
    baseSlug: string,
    build: (slug: string) => InsertNewsRow,
    maxAttempts = 6,
  ): Promise<{ id: string }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = uniquifySlug(baseSlug, attempt);
      try {
        return await deps.insertNews(build(candidate));
      } catch (err) {
        if (isUniqueViolation(err) && attempt < maxAttempts - 1) continue;
        throw err;
      }
    }
    throw new NewsError('slug_conflict', 'Не удалось подобрать уникальный slug.');
  }

  const createNews = defineAction({
    permission: 'news.write',
    input: NewsCreateSchema,
    deps: actionDeps,
    handler: async (data, ctx: ActionCtx) => {
      await assertNewsEnabled();

      // Пустой заголовок без латиницы/кириллицы/цифр → slugify('')='' ломает ЧПУ;
      // фолбэк 'news-<token>' гарантирует непустой валидный slug (как каталог/cms).
      const base = data.slug || slugifyOrFallback(data.title, '', undefined, 'news');
      const safeBody = data.body !== undefined ? sanitizeHtml(data.body) : null;

      const row = await insertWithUniqueSlug(base, (slug) => ({
        slug,
        title: data.title,
        groupLabel: data.groupLabel ?? null,
        excerpt: data.excerpt ?? null,
        body: safeBody,
        coverImageKey: data.coverImageKey ?? null,
        status: (data.status ?? 'draft') as NewsStatus,
        publishedAt: data.publishedAt ?? null,
        sortOrder: data.sortOrder ?? 0,
        seoTitle: data.seoTitle ?? null,
        seoDescription: data.seoDescription ?? null,
        ogTitle: data.ogTitle ?? null,
        ogDescription: data.ogDescription ?? null,
        ogImageKey: data.ogImageKey ?? null,
        noindex: data.noindex ?? false,
        canonicalUrl: data.canonicalUrl ?? null,
        createdBy: ctx.user.id,
      }));

      return {
        result: { id: row.id },
        revalidate: [NEWS_LIST_PATH, newsPath(row.id)],
        audit: {
          action: 'news.create',
          entityType: 'news',
          entityId: row.id,
          after: { slug: base, title: data.title, status: data.status ?? 'draft' },
        },
      };
    },
  });

  const updateNewsAction = defineAction({
    permission: 'news.write',
    input: NewsUpdateSchema,
    deps: actionDeps,
    handler: async (data, ctx) => {
      await assertNewsEnabled();

      const before = await deps.getNewsById(data.id);
      if (!before) {
        throw new NewsError('not_found', 'Новость не найдена.');
      }

      // Оверлей переводов: whitelist × не-дефолтные языки; provided=false → не трогаем.
      const localeConfig = await deps.getLocaleConfig();
      const tr = resolveTranslationsUpdate(
        NEWS_TRANSLATABLE_FIELDS,
        data.translations,
        before.translations,
        localeConfig,
      );
      // Санитизация rich-text body в каждом языке оверлея (анти-XSS).
      const safeTranslations = tr.provided
        ? sanitizeTranslationsBody(tr.value)
        : tr.value;

      let after: NewsArticle | null;
      try {
        after = await deps.updateNews({
          id: data.id,
          slug: data.slug,
          title: data.title,
          groupLabel: data.groupLabel,
          groupLabelProvided: data.groupLabel !== undefined,
          excerpt: data.excerpt,
          excerptProvided: data.excerpt !== undefined,
          // Базовый (ru) body санитайзится перед записью.
          body: data.body !== undefined ? sanitizeHtml(data.body) : undefined,
          bodyProvided: data.body !== undefined,
          coverImageKey: data.coverImageKey,
          coverImageKeyProvided: data.coverImageKey !== undefined,
          status: data.status as NewsStatus | undefined,
          publishedAt: data.publishedAt,
          publishedAtProvided: data.publishedAt !== undefined,
          sortOrder: data.sortOrder,
          seoTitle: data.seoTitle,
          seoTitleProvided: data.seoTitle !== undefined,
          seoDescription: data.seoDescription,
          seoDescriptionProvided: data.seoDescription !== undefined,
          ogTitle: data.ogTitle,
          ogTitleProvided: data.ogTitle !== undefined,
          ogDescription: data.ogDescription,
          ogDescriptionProvided: data.ogDescription !== undefined,
          ogImageKey: data.ogImageKey,
          ogImageKeyProvided: data.ogImageKey !== undefined,
          noindex: data.noindex,
          canonicalUrl: data.canonicalUrl,
          canonicalUrlProvided: data.canonicalUrl !== undefined,
          translations: safeTranslations,
          translationsProvided: tr.provided,
          updatedBy: ctx.user.id,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PublicActionError('errors.newsAction.slugExists');
        }
        throw err;
      }
      if (!after) {
        throw new NewsError('not_found', 'Новость не найдена.');
      }

      return {
        result: { id: data.id },
        revalidate: [NEWS_LIST_PATH, newsPath(data.id)],
        audit: {
          action: 'news.update',
          entityType: 'news',
          entityId: data.id,
          before: { slug: before.slug, title: before.title, status: before.status },
          after: { slug: after.slug, title: after.title, status: after.status },
        },
      };
    },
  });

  const setNewsStatus = defineAction({
    permission: 'news.write',
    input: NewsSetStatusSchema,
    deps: actionDeps,
    handler: async (data, ctx) => {
      await assertNewsEnabled();

      const before = await deps.getNewsById(data.id);
      if (!before) {
        throw new NewsError('not_found', 'Новость не найдена.');
      }
      const target = data.status as NewsStatus;
      if (before.status !== target && !canTransitionNews(before.status, target)) {
        throw new NewsError(
          'invalid_transition',
          `Недопустимый переход статуса: ${before.status} → ${target}.`,
        );
      }

      const after = await deps.updateNewsStatus(data.id, target, ctx.user.id);
      if (!after) {
        throw new NewsError('not_found', 'Новость не найдена.');
      }

      return {
        result: { id: data.id, status: target },
        revalidate: [NEWS_LIST_PATH, newsPath(data.id)],
        audit: {
          action: 'news.status.change',
          entityType: 'news',
          entityId: data.id,
          before: { status: before.status },
          after: { status: target },
        },
      };
    },
  });

  const deleteNewsAction = defineAction({
    permission: 'news.write',
    input: NewsIdSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertNewsEnabled();
      const removed = await deps.deleteNews(data.id);
      if (!removed) {
        throw new NewsError('not_found', 'Новость не найдена.');
      }
      return {
        result: { id: data.id },
        revalidate: [NEWS_LIST_PATH],
        audit: {
          action: 'news.delete',
          entityType: 'news',
          entityId: data.id,
          before: { slug: removed.slug },
        },
      };
    },
  });

  return { createNews, updateNews: updateNewsAction, setNewsStatus, deleteNews: deleteNewsAction };
}

export { PublicActionError };
