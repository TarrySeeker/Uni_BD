/**
 * Публичные DTO новостей для Storefront API (docs/24 §3, ADR-i18n docs/24 §1).
 *
 * ПРИНЦИП (как toProductDetailDto/cms-dto): витрине отдаём ТОЛЬКО публично-безопасные
 * поля. СКРЫВАЕМ: id, status, created_by/updated_by, timestamps, сырые ключи S3
 * (→ coverUrl/og-URL). Отдаём: slug, title, groupLabel, excerpt (лента) + body/meta
 * (деталь). Переводимые поля резолвятся по ctx.locale через оверлей translations
 * (localizeEntity, whitelist NEWS_TRANSLATABLE_FIELDS); ФОРМА DTO не меняется —
 * меняются только ЗНАЧЕНИЯ.
 *
 * Чистые функции — тестируемы без БД/Next.
 */

import { buildSeoMeta, type SeoCtx } from '@/lib/seo/meta';
import { NEWS_TRANSLATABLE_FIELDS } from '@/lib/news/fields';
import type { NewsArticle, NewsListRow } from '@/lib/news/types';
import { localizeEntity, type LocalizeCtx } from './locale';
import type { SeoMetaDto, PublicUrlResolver } from './dto';

export type { PublicUrlResolver } from './dto';

/** Публичная строка ленты новостей (для GET /news). Без body. */
export interface PublicNewsListItemDto {
  slug: string;
  title: string;
  groupLabel: string | null;
  excerpt: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
}

/** Публичная деталь новости (для GET /news/[slug]). С body + SEO/OG-мета. */
export interface PublicNewsDetailDto {
  slug: string;
  title: string;
  groupLabel: string | null;
  excerpt: string | null;
  body: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  meta: SeoMetaDto;
}

/** Поля списка/ленты, локализуемые через оверлей (пересечение whitelist × NewsListRow). */
const LIST_TR_FIELDS = [
  'title',
  'groupLabel',
  'excerpt',
  'seoTitle',
  'seoDescription',
  'ogTitle',
  'ogDescription',
] as const;

/** Собирает SEO-мету новости через чистый билдер. og/cover — ключи S3 → URL. */
function newsMeta(article: NewsArticle, ctx: SeoCtx): SeoMetaDto {
  return buildSeoMeta(
    {
      slug: article.slug,
      name: article.title,
      seoTitle: article.seoTitle,
      seoDescription: article.seoDescription ?? article.excerpt,
      ogTitle: article.ogTitle,
      ogDescription: article.ogDescription,
      // og:image — явный OG-ключ, иначе обложка (оба резолвятся ctx.publicUrl).
      ogImageKey: article.ogImageKey ?? article.coverImageKey,
      canonicalUrl: article.canonicalUrl,
      noindex: article.noindex,
    },
    ctx,
  );
}

/** Строка ленты (домен, без body) → публичный DTO. */
export function toPublicNewsListDto(
  row: NewsListRow,
  publicUrl: PublicUrlResolver,
  loc?: LocalizeCtx,
): PublicNewsListItemDto {
  const l = localizeEntity(row, LIST_TR_FIELDS, loc);
  return {
    slug: l.slug,
    title: l.title,
    groupLabel: l.groupLabel,
    excerpt: l.excerpt,
    coverUrl: l.coverImageKey ? publicUrl(l.coverImageKey) : null,
    publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
  };
}

/** Новость (домен, с body) → публичный DTO детали. */
export function toPublicNewsDetailDto(
  article: NewsArticle,
  seoCtx: SeoCtx,
  publicUrl: PublicUrlResolver = seoCtx.publicUrl,
  loc?: LocalizeCtx,
): PublicNewsDetailDto {
  const l = localizeEntity(article, NEWS_TRANSLATABLE_FIELDS, loc);
  return {
    slug: l.slug,
    title: l.title,
    groupLabel: l.groupLabel,
    excerpt: l.excerpt,
    body: l.body,
    coverUrl: l.coverImageKey ? publicUrl(l.coverImageKey) : null,
    publishedAt: l.publishedAt ? l.publishedAt.toISOString() : null,
    meta: newsMeta(l, seoCtx),
  };
}
