/**
 * Доменные типы среза «Новости» (docs/24 §3).
 *
 * Типы прикладного уровня (camelCase), отображающие строки таблицы news.
 * Маппинг row(snake_case)→domain(camelCase) — в repository.ts (map*). Образец —
 * lib/cms/types.ts. Порт eAdmin b_news, коллапсированный в одну сущность + i18n-оверлей.
 */

import type { TranslationsMap } from '@/lib/i18n';

/** Жизненный цикл новости (news.status). Триада как у cms_pages/products. */
export type NewsStatus = 'draft' | 'published' | 'archived';
export const NEWS_STATUSES: readonly NewsStatus[] = [
  'draft',
  'published',
  'archived',
] as const;

/** Новость (полная запись — для админ-карточки и витрины-детали). */
export interface NewsArticle {
  id: string;
  /** ЧПУ (citext, уникален). НЕ переводимо. */
  slug: string;
  /** Заголовок. База = язык по умолчанию (ru). Переводимо. */
  title: string;
  /** Рубрика/раздел. Переводимо. */
  groupLabel: string | null;
  /** Анонс. Переводимо. */
  excerpt: string | null;
  /** Текст (rich HTML, санитайзится). Переводимо. */
  body: string | null;
  /** Ключ обложки в S3 (URL собирает витрина). НЕ переводимо. */
  coverImageKey: string | null;
  status: NewsStatus;
  /** Дата публикации; null — не публиковалась. */
  publishedAt: Date | null;
  sortOrder: number;
  // SEO/OG:
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Ключ OG-картинки в S3. НЕ переводимо. */
  ogImageKey: string | null;
  noindex: boolean;
  canonicalUrl: string | null;
  /** Сырой jsonb-оверлей переводов (whitelist NEWS_TR_FIELDS). Резолв — в DTO/форме. */
  translations: TranslationsMap;
  // audit:
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Строка списка новостей (для таблицы /admin/news и витринной ленты — без body). */
export interface NewsListRow {
  id: string;
  slug: string;
  title: string;
  groupLabel: string | null;
  excerpt: string | null;
  coverImageKey: string | null;
  status: NewsStatus;
  publishedAt: Date | null;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageKey: string | null;
  noindex: boolean;
  canonicalUrl: string | null;
  translations: TranslationsMap;
  updatedAt: Date;
}
