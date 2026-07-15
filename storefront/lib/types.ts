/**
 * Публичные DTO Storefront API — подмножество полей, используемых витриной.
 * Форма сверена с `Uni_BD/lib/storefront/*` (dto.ts, settings-dto.ts) и
 * `docs/21-контракт-storefront-api.md`. Деньги товаров приходят строкой NUMERIC
 * в рублях (напр. "7500.00").
 */

export interface BrandDto {
  slug: string;
  name: string;
  logoUrl: string | null;
}

export interface ProductListItemDto {
  slug: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  imageUrl: string | null;
  inStock: boolean;
  availableQty: number;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  count: number;
}

export interface ProductsResponse {
  data: ProductListItemDto[];
  pagination: Pagination;
}

export interface CategoryDto {
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  children: CategoryDto[];
}

export interface MediaDto {
  url: string | null;
  type: string;
  alt: string;
  isPrimary: boolean;
}

export interface VariantDto {
  id: string;
  sku: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  attributes: Record<string, unknown>;
  inStock: boolean;
  availableQty: number;
}

export interface DesignerDto {
  slug: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Полный дизайнер для публичной страницы /designers/[slug]. Зеркалит 1:1
 * Admik `FullDesignerDto` (lib/storefront/dto.ts → toFullDesignerDto): внутренние
 * поля скрыты, imageUrl/pageImageUrl — уже публичные URL (не S3-ключи).
 */
export interface FullDesignerDto extends DesignerDto {
  country: string | null;
  description: string;
  pageImageUrl: string | null;
  videoUrl: string | null;
  socials: Record<string, string>;
  workCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  meta: SeoMetaDto;
}

export interface SeoMetaDto {
  title: string | null;
  description: string | null;
  canonical?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
}

export interface ProductDetailDto {
  id: string;
  slug: string;
  sku: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  designer: DesignerDto | null;
  categories: string[];
  attributes: Record<string, unknown>;
  variants: VariantDto[];
  media: MediaDto[];
  inStock: boolean;
  availableQty: number;
  meta: SeoMetaDto;
}

export interface PublicSocialDto {
  type: string;
  url: string;
}

// -----------------------------------------------------------------------------
// CMS-страницы (docs/11 §5.1.4, ADR-012). Форма сверена 1:1 с публичным DTO
// Admik (lib/storefront/cms-dto.ts → toPublicPageDto) и Zod-схемами секций
// (lib/cms/schemas.ts). Секция — { type, content }, где content дискриминирован
// полем type. Сырые ключи хранилища уже заменены публичными URL на стороне API
// (imageKey → imageUrl), поэтому здесь только *Url-поля.
// -----------------------------------------------------------------------------

/** Карта content по типу секции (после резолва медиа imageKey → imageUrl). */
export interface SectionContentByType {
  /** Rich-text: сервер-санитизированный HTML (admin-authored). */
  text: { html: string };
  hero: {
    title: string;
    subtitle?: string;
    html?: string;
    imageUrl?: string;
    ctaLabel?: string;
    ctaHref?: string;
  };
  banner: { imageUrl?: string; href?: string; alt?: string };
  gallery: { images: { imageUrl?: string; alt?: string }[] };
  faq: { items: { q: string; a: string }[] };
  /**
   * Подборка товаров по slug-фильтру (БЕЗ FK на каталог — витрина дотягивает
   * товары через существующий /products; инвариант 5.1). limit — из схемы (деф. 12).
   */
  products_grid: {
    mode: 'slugs' | 'category' | 'brand';
    slugs?: string[];
    categorySlug?: string;
    brandSlug?: string;
    limit?: number;
    title?: string;
  };
  cta: { title: string; html?: string; buttonLabel: string; buttonHref: string };
}

/** Тип секции CMS (дискриминатор). */
export type CmsSectionType = keyof SectionContentByType;

/** Публичная секция страницы — дискриминированный union по `type`. */
export type PageSection = {
  [K in CmsSectionType]: { type: K; content: SectionContentByType[K] };
}[CmsSectionType];

/** Публичная CMS-страница (детальная, для /pages/[slug]). */
export interface PageDto {
  slug: string;
  title: string;
  meta: SeoMetaDto;
  sections: PageSection[];
}

export interface PublicSettingsDto {
  branding: {
    shopName: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    theme: {
      primaryColor: string | null;
      accentColor: string | null;
      mode: 'light' | 'dark' | 'system';
    };
    supportEmail: string | null;
    supportPhone: string | null;
  };
  currency: {
    code: string;
    symbol: string | null;
    locale: string | null;
    fractionDigits: number;
  };
  contacts: {
    phone: string | null;
    email: string | null;
    address: string | null;
    workingHours: string | null;
    socials: PublicSocialDto[];
  };
  seo: {
    siteName: string | null;
    siteUrl: string | null;
    titleTemplate: string;
    defaultDescription: string | null;
    twitterSite: string | null;
  };
  home: {
    hero: {
      title: string | null;
      subtitle: string | null;
      imageUrl: string | null;
      ctaLabel: string | null;
      ctaHref: string | null;
    };
    about: { title: string; paragraphs: string[]; imageUrls: string[]; values: string[] };
    /** ТЗ_2 — «Образы» (lookbook): категории с фото (imageUrl) + заголовок/текст. */
    looks: {
      enabled: boolean;
      title: string;
      categories: { title: string; text: string; imageUrl: string }[];
    };
    /** M4 — «Плитки категорий» (.dop-links--adaptive): показ + плитки (imageUrl — публичный URL). */
    tiles: {
      enabled: boolean;
      items: { title: string; href: string; imageUrl: string }[];
    };
    /** M4 — «Видео» (.mainpage--video): показ + embedUrl (уже готовый публичный URL). */
    video: { enabled: boolean; embedUrl: string };
    /** M4 — «Витрина дизайнеров» (.mainpage--designers): avatarUrl/workUrl — публичные URL, *Top — inline top в %. */
    designers: {
      enabled: boolean;
      title: string;
      items: {
        name: string;
        href: string;
        avatarUrl: string;
        workUrl: string;
        avatarTop: number;
        workTop: number;
      }[];
    };
  };
  navigation: {
    header: { label: string; href: string }[];
    footer: { title: string; links: { label: string; href: string }[] }[];
  };
}
