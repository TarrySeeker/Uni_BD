/**
 * Чистый билдер SEO-меты сущности (docs/11 §5.3.4, пакет 5.S-1).
 *
 * buildSeoMeta(entity, seoCtx) собирает title/description/canonical/og/noindex
 * БЕЗ чтения process.env/БД/storage: домен/шаблон/настройки/publicUrl передаются
 * параметром `seoCtx`. Тестируется без БД. Наружу отдаётся `ogImageUrl` (НЕ ключ
 * S3): URL собирается инъецированным `seoCtx.publicUrl(key)` — домен не хардкодим.
 *
 * Инварианты (§5.3.7):
 *   - title через title_template ('%s' ⇒ подстановка; голый '%s' ⇒ без суффикса);
 *   - пустой seoTitle ⇒ fallback на name;
 *   - canonical = canonical_url ?? `${site_url}/<pathPrefix>/<slug>` (если есть домен);
 *   - og_image_key → publicUrl ?? default_og_image_key → publicUrl ?? null.
 */

import { isSafeCanonical } from '@/lib/seo/schemas';

/** Входная сущность для билдера меты (минимальный SEO-контракт). */
export interface SeoEntityInput {
  slug: string;
  name: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImageKey?: string | null;
  canonicalUrl?: string | null;
  noindex?: boolean;
}

/**
 * Контекст SEO (домен/шаблон/настройки) — инъецируется параметром, НЕ читается
 * внутри билдера. `publicUrl` — функция сборки URL объекта (storage.publicUrl).
 */
export interface SeoCtx {
  /** Базовый домен (shop_settings.seo.site_url); null → canonical/og:url не автогенерим. */
  siteUrl: string | null;
  /** Шаблон заголовка с '%s' (shop_settings.seo.title_template). */
  titleTemplate: string;
  /** Имя сайта (для JSON-LD/fallback). */
  siteName: string | null;
  /** Дефолтное описание (shop_settings.seo.default_description). */
  defaultDescription: string | null;
  /** Дефолтный ключ OG-изображения (shop_settings.seo.default_og_image_key). */
  defaultOgImageKey: string | null;
  /** Сборка публичного URL объекта по ключу (инъекция storage.publicUrl). */
  publicUrl: (key: string) => string;
  /** Префикс пути сущности для автоген-canonical (product/category/brand/...). */
  pathPrefix: string;
}

/** Готовая SEO-мета (наружу — ogImageUrl, не ключ). */
export interface SeoMeta {
  title: string;
  description: string | null;
  canonical: string | null;
  ogTitle: string;
  ogDescription: string | null;
  ogImageUrl: string | null;
  noindex: boolean;
}

/** Непустая строка после трима, иначе null. */
function trimmed(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Прогоняет базовый заголовок через title_template, подставляя его во ВСЕ вхождения
 * '%s'. Голый '%s' (без суффикса) ⇒ возвращает заголовок как есть. Если в шаблоне нет
 * '%s' — он используется как есть (валидация шаблона — на уровне action, здесь билдер
 * толерантен).
 *
 * m7: `replaceAll` (а не `replace`) — `replace` со строковым искомым заменяет только
 * ПЕРВОЕ вхождение, и шаблон с несколькими '%s' («%s — %s») оставлял бы литеральный
 * '%s' в публичном title.
 *
 * ВАЖНО (баг A волны 5): `base` — контент-контролируемый текст (seoTitle/name).
 * Передаём его ФУНКЦИЕЙ-заменой `() => base`, а не строкой: строковый аргумент
 * String.prototype.replace раскрывает доллар-последовательности ($$, $&, $`, $',
 * $n) как спец-паттерны и портит публичный SEO/OG title. Function-replacer
 * подставляет текст буквально, без раскрытия $-паттернов (сохраняется и в replaceAll).
 */
function applyTitleTemplate(base: string, template: string): string {
  if (!template.includes('%s')) return base;
  return template.replaceAll('%s', () => base);
}

/** Собирает canonical: явный (абсолютный как есть / path → достраивается) или автоген. */
function buildCanonical(
  canonicalUrl: string | null,
  slug: string,
  pathPrefix: string,
  siteUrl: string | null,
): string | null {
  const explicit = trimmed(canonicalUrl);
  if (explicit && isSafeCanonical(explicit)) {
    if (explicit.startsWith('/')) {
      return siteUrl ? `${siteUrl}${explicit}` : null;
    }
    return explicit; // абсолютный https — как есть.
  }
  // Автоген из slug + домена (если домен задан).
  if (!siteUrl) return null;
  return `${siteUrl}/${pathPrefix}/${slug}`;
}

/** Собирает ogImageUrl: ключ сущности → publicUrl; иначе дефолтный ключ → publicUrl; иначе null. */
function buildOgImageUrl(ctx: SeoCtx, ogImageKey: string | null | undefined): string | null {
  const key = trimmed(ogImageKey) ?? trimmed(ctx.defaultOgImageKey);
  return key ? ctx.publicUrl(key) : null;
}

/**
 * Строит SEO-мету сущности по контексту (чистая функция).
 */
export function buildSeoMeta(entity: SeoEntityInput, ctx: SeoCtx): SeoMeta {
  const baseTitle = trimmed(entity.seoTitle) ?? entity.name;
  const title = applyTitleTemplate(baseTitle, ctx.titleTemplate);

  const description = trimmed(entity.seoDescription) ?? trimmed(ctx.defaultDescription);

  const canonical = buildCanonical(
    entity.canonicalUrl ?? null,
    entity.slug,
    ctx.pathPrefix,
    ctx.siteUrl,
  );

  const ogTitle = trimmed(entity.ogTitle) ?? title;
  const ogDescription = trimmed(entity.ogDescription) ?? description;
  const ogImageUrl = buildOgImageUrl(ctx, entity.ogImageKey);

  return {
    title,
    description,
    canonical,
    ogTitle,
    ogDescription,
    ogImageUrl,
    noindex: entity.noindex ?? false,
  };
}

/** Опции JSON-LD: тип Schema.org (MVP — Product/BreadcrumbList/Organization). */
export interface JsonLdOptions {
  type: 'Product' | 'BreadcrumbList' | 'Organization';
}

/**
 * Опциональный JSON-LD для сущности (чистая функция). MVP: минимальный объект с
 * name/url. url берётся из того же canonical-автогена (домен из ctx, не хардкод).
 */
export function buildJsonLd(
  entity: SeoEntityInput,
  ctx: SeoCtx,
  opts: JsonLdOptions,
): Record<string, unknown> {
  const url = buildCanonical(entity.canonicalUrl ?? null, entity.slug, ctx.pathPrefix, ctx.siteUrl);
  return {
    '@context': 'https://schema.org',
    '@type': opts.type,
    name: entity.name,
    ...(url ? { url } : {}),
  };
}
