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
  };
  navigation: {
    header: { label: string; href: string }[];
    footer: { title: string; links: { label: string; href: string }[] }[];
  };
}
