/**
 * Доменные типы структурных секций карточки товара (product_blocks, §9).
 * Порт eAdmin b_work_block: цитата с автором, табы, текст, картинка.
 *
 * URL картинок в доменной модели НЕ храним — держим ключ объекта (image_key),
 * URL собирается на границе (storefront DTO / админка) через storage.url(key),
 * зеркально media/designer.imageKey.
 *
 * Автор цитаты — кросс-линк на дизайнера (DesignerRef), резолвится LEFT JOIN в
 * репозитории (как products→designer). При отсутствии автора — null.
 */

import type { TranslationsMap } from '@/lib/i18n';
import type { DesignerRef } from '@/lib/designers/types';

/** Вид секции карточки товара (нормализация b_work_block.type). */
export type ProductBlockType = 'text' | 'quote' | 'tabs' | 'image';

/** Все допустимые типы секций (единый источник для Zod-enum и UI-селектора). */
export const PRODUCT_BLOCK_TYPES: readonly ProductBlockType[] = [
  'text',
  'quote',
  'tabs',
  'image',
] as const;

/** Один таб секции (порт tab_one..four_name/text). Переводится структурно. */
export interface ProductBlockTab {
  name: string;
  text: string;
}

/** Структурная секция карточки товара (product_blocks). */
export interface ProductBlock {
  id: string;
  productId: string;
  type: ProductBlockType;
  /** Заголовок (переводимо). */
  title: string | null;
  /** Цитата (переводимо). */
  blockquot: string | null;
  /** Автор цитаты → дизайнер (FK author_designer_id; SET NULL при удалении). */
  authorDesignerId: string | null;
  /** Кросс-линк на автора-персону (резолвится JOIN; null — без автора). */
  author: DesignerRef | null;
  /** Rich HTML-описание (переводимо). */
  body: string | null;
  /** Ключ объекта картинки секции в хранилище; URL собирается на границе. */
  imageKey: string | null;
  /** Табы (структурный контент; переводится через оверлей translations[locale].tabs). */
  tabs: ProductBlockTab[];
  sort: number;
  /** Сырой jsonb-оверлей переводов: locale→{title|blockquot|body|tabs}. Резолв в DTO/форме. */
  translations: TranslationsMap;
  createdAt: Date;
}
