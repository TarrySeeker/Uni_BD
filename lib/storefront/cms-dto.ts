/**
 * Публичный DTO CMS-страницы для Storefront API (docs/11 §5.1.4, ADR-012).
 *
 * ПРИНЦИП (как у toProductDetailDto): витрине отдаём ТОЛЬКО публично-безопасные
 * поля. СКРЫВАЕМ: id, status, created_by/updated_by, все timestamps, ревизии,
 * сырые draft-страницы (роут отдаёт только published — фильтр в репозитории).
 *
 * Отдаём: slug, title, meta (через чистый buildSeoMeta — домен/og:image из SeoCtx,
 * не хардкод) и sections — ТОЛЬКО enabled=true, по display_order, каждая как
 * { type, content }. Для секции products_grid content несёт slug-фильтр товаров
 * (mode/slugs/categorySlug/brandSlug/limit) БЕЗ FK на каталог — витрина дотягивает
 * товары через существующий /products (модули cms и catalog независимы, инвариант 5.1).
 *
 * Чистые функции — тестируемы без БД/Next.
 */

import { buildSeoMeta, type SeoCtx } from '@/lib/seo/meta';
import type { SeoMetaDto, PublicUrlResolver } from './dto';
import type {
  CmsPage,
  CmsPageWithSections,
  CmsSection,
  CmsSectionType,
} from '@/lib/cms/types';

/** Публичная секция: только дискриминатор type + валидированный content. */
export interface PublicSectionDto {
  type: CmsSectionType;
  content: Record<string, unknown>;
}

/** Публичная CMS-страница (детальная, для /pages/[slug]). */
export interface PublicPageDto {
  slug: string;
  title: string;
  meta: SeoMetaDto;
  sections: PublicSectionDto[];
}

/** Публичная строка списка страниц (для /pages — навигация витрины). */
export interface PublicPageListItemDto {
  slug: string;
  title: string;
  meta: SeoMetaDto;
}

/**
 * Собирает SeoMetaDto страницы через чистый билдер. og_image у CMS-страниц хранится
 * как готовый публичный URL (cms_pages.og_image_url), а не ключ S3 — поэтому
 * передаём его в билдер через ogImageKey + publicUrl-identity-обёртку (URL уже
 * абсолютный; SeoCtx.publicUrl всё равно его не переписывает для http(s)-значения).
 */
function pageMeta(page: CmsPage, ctx: SeoCtx): SeoMetaDto {
  // og_image_url уже публичный URL — оборачиваем publicUrl так, чтобы абсолютный
  // URL отдавался как есть, а пустой ключ привёл к дефолтному (default_og_image_key).
  const ctxForPage: SeoCtx = {
    ...ctx,
    publicUrl: (key: string) =>
      /^https?:\/\//i.test(key) ? key : ctx.publicUrl(key),
  };
  return buildSeoMeta(
    {
      slug: page.slug,
      name: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: page.ogImageUrl,
      canonicalUrl: page.canonicalUrl,
      noindex: page.noindex,
    },
    ctxForPage,
  );
}

/**
 * Резолвер ключ объекта хранилища → публичный URL (инъекция storage.url).
 * Единый источник истины — lib/storefront/dto; переэкспорт для обратной
 * совместимости импортов из cms-dto.
 */
export type { PublicUrlResolver } from './dto';

/**
 * Подменяет в content секции СЫРЫЕ ключи хранилища публичными URL: витрине НЕ
 * раскрываем storage_key (инвариант, зеркально каталог-медиа toMediaDto). По типу
 * секции: hero/banner — `imageKey` → `imageUrl`; gallery — `images[].imageKey` →
 * `images[].imageUrl`. Сырой ключ удаляется. Прочие типы (text/products_grid/
 * faq/cta) изображений не несут и возвращаются как есть.
 */
function resolveSectionMedia(
  type: CmsSectionType,
  content: Record<string, unknown>,
  publicUrl: PublicUrlResolver,
): Record<string, unknown> {
  if (type === 'hero' || type === 'banner') {
    const { imageKey, ...rest } = content as { imageKey?: unknown };
    if (typeof imageKey === 'string') {
      return { ...rest, imageUrl: publicUrl(imageKey) };
    }
    return { ...rest };
  }

  if (type === 'gallery') {
    const images = Array.isArray((content as { images?: unknown }).images)
      ? ((content as { images: Array<Record<string, unknown>> }).images)
      : [];
    return {
      ...content,
      images: images.map((img) => {
        const { imageKey, ...rest } = img as { imageKey?: unknown };
        return typeof imageKey === 'string'
          ? { ...rest, imageUrl: publicUrl(imageKey) }
          : { ...rest };
      }),
    };
  }

  return content;
}

/**
 * Секция домена → публичная { type, content } (без id/enabled/timestamps).
 * `publicUrl` инъецируется роутом (storage.url) — сырые ключи изображений
 * заменяются публичными URL (см. resolveSectionMedia).
 */
function toPublicSectionDto(
  section: CmsSection,
  publicUrl: PublicUrlResolver,
): PublicSectionDto {
  return {
    type: section.type,
    content: resolveSectionMedia(section.type, section.content, publicUrl),
  };
}

/**
 * Страница со связанными секциями → публичный DTO.
 *
 * sections: только enabled=true, отсортированы по displayOrder (стабильно по id
 * при равном порядке). Скрывает все служебные поля страницы и секций.
 */
export function toPublicPageDto(
  page: CmsPageWithSections,
  seoCtx: SeoCtx,
  publicUrl: PublicUrlResolver = seoCtx.publicUrl,
): PublicPageDto {
  const sections = page.sections
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) =>
      a.displayOrder !== b.displayOrder
        ? a.displayOrder - b.displayOrder
        : a.id.localeCompare(b.id),
    )
    .map((s) => toPublicSectionDto(s, publicUrl));

  return {
    slug: page.slug,
    title: page.title,
    meta: pageMeta(page, seoCtx),
    sections,
  };
}

/** Страница (без секций) → строка списка (для /pages). */
export function toPublicPageListItemDto(
  page: CmsPage,
  seoCtx: SeoCtx,
): PublicPageListItemDto {
  return {
    slug: page.slug,
    title: page.title,
    meta: pageMeta(page, seoCtx),
  };
}
