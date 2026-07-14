/**
 * Доменные типы дизайнеров (§9, ADR §4.4). Порт b_stuff «Персона».
 *
 * Моделируется 1:1 по анатомии Brand (lib/catalog/types): публичная сущность с
 * аватаром, rich-описанием, SEO/OG-метаполями и оверлеем переводов. Отличия от
 * бренда семантические — страна/соцсети/видео/счётчик работ/фото страницы.
 *
 * URL картинок в доменной модели НЕ храним: держим ключ объекта (image_key,
 * page_image_key, og_image_key), URL собирается на границе (DTO/админка) через
 * storage.url(key) — зеркально brand.logoKey / og:image.
 */

import type { TranslationsMap } from '@/lib/i18n';

/** Соцсети персоны (произвольный набор ссылок; b_stuff.soc_*). */
export type DesignerSocials = Record<string, string>;

/**
 * Краткая ссылка на дизайнера для развёрнутой проекции товара (кросс-линк
 * товар→дизайнер). Аналог BrandRef. Ключ аватара резолвится в URL на границе.
 */
export interface DesignerRef {
  id: string;
  slug: string;
  name: string;
  /** Ключ объекта аватара в хранилище (как brand.logoKey). URL собирает DTO/админка. */
  imageKey: string | null;
}

/** Дизайнер / персона (designers, §9, ADR §4.4). */
export interface Designer {
  id: string;
  slug: string;
  name: string;
  /** Страна (переводима). */
  country: string | null;
  /** Rich-описание (переводимо). */
  description: string;
  /** Ключ объекта аватара в хранилище; URL собирается на границе (как brand.logoKey). */
  imageKey: string | null;
  /** Ключ объекта фото для публичной страницы. */
  pageImageKey: string | null;
  /** Ссылка на видео Vimeo/YouTube. */
  videoUrl: string | null;
  /** Соцсети { fb, inst, ... }. */
  socials: DesignerSocials;
  /** Счётчик работ (маркетинговый; редактируемое поле). */
  workCount: number;
  isActive: boolean;
  sort: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  /** Ключ объекта OG-изображения в хранилище (URL собирает storage). */
  ogImageKey: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  /** Сырой jsonb-оверлей переводов (ADR-i18n): locale→{field→value}. Резолв в DTO/форме. */
  translations?: TranslationsMap;
  createdAt: Date;
  updatedAt: Date;
}
