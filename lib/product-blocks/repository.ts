/**
 * Слой чтения/записи структурных секций товара (product_blocks, §9).
 *
 * Только параметризованный `sql` (tagged templates → анти-SQLi). Мапперы
 * row(snake)→domain(camel) — чистые функции, экспортируются для юнит-тестов (БД
 * не нужна). translations/tabs тянутся СЫРЫМИ (locale-агностично); резолв
 * переводимых полей — на границе (storefront DTO по ctx.locale; admin по вкладке).
 *
 * Автор цитаты (author_designer_id) резолвится LEFT JOIN designers → DesignerRef
 * (кросс-линк), зеркально products→designer в lib/catalog/repository.
 */

import { sql } from '@/lib/db/client';
import type { TransactionSql } from 'postgres';
import type { TranslationsMap } from '@/lib/i18n';
import type { DesignerRef } from '@/lib/designers/types';

import type { ProductBlock, ProductBlockTab, ProductBlockType } from './types';

// -----------------------------------------------------------------------------
// Чистые мапперы row→domain.
// -----------------------------------------------------------------------------

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** Сырой jsonb-объект → Record. Не-объект/массив/NULL → {}. */
function asObject<T extends Record<string, unknown>>(v: unknown): T {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as T;
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as T)
        : ({} as T);
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

/** Сырой jsonb-массив табов → нормализованный ProductBlockTab[]. Мусор → []. */
export function asTabs(v: unknown): ProductBlockTab[] {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.map((t) => {
    const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
    return {
      name: typeof o.name === 'string' ? o.name : '',
      text: typeof o.text === 'string' ? o.text : '',
    };
  });
}

/** Автор-ref из JOIN-колонок (d_*); null — если author_designer_id пуст. */
export function mapBlockAuthorRef(row: Record<string, unknown>): DesignerRef | null {
  if (!row.d_id) {
    return null;
  }
  return {
    id: String(row.d_id),
    slug: String(row.d_slug),
    name: String(row.d_name),
    imageKey: (row.d_image_key as string | null) ?? null,
  };
}

/** Полный маппер секции (product_blocks + JOIN автора). */
export function mapProductBlock(row: Record<string, unknown>): ProductBlock {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    type: String(row.type) as ProductBlockType,
    title: (row.title as string | null) ?? null,
    blockquot: (row.blockquot as string | null) ?? null,
    authorDesignerId: (row.author_designer_id as string | null) ?? null,
    author: mapBlockAuthorRef(row),
    body: (row.body as string | null) ?? null,
    imageKey: (row.image_key as string | null) ?? null,
    tabs: asTabs(row.tabs),
    sort: Number(row.sort ?? 0),
    translations: asObject<TranslationsMap>(row.translations),
    createdAt: asDate(row.created_at),
  };
}

// -----------------------------------------------------------------------------
// Чтения.
// -----------------------------------------------------------------------------

/** Секции товара в порядке отображения (sort, затем created_at). */
export async function listBlocksByProduct(productId: string): Promise<ProductBlock[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT pb.id, pb.product_id, pb.type, pb.title, pb.blockquot,
           pb.author_designer_id, pb.body, pb.image_key, pb.tabs, pb.sort,
           pb.translations, pb.created_at,
           d.id AS d_id, d.slug AS d_slug, d.name AS d_name, d.image_key AS d_image_key
    FROM product_blocks pb
    LEFT JOIN designers d ON d.id = pb.author_designer_id
    WHERE pb.product_id = ${productId}
    ORDER BY pb.sort, pb.created_at
  `;
  return rows.map(mapProductBlock);
}

/** Секция по id (с автором) или null. */
export async function getBlockById(id: string): Promise<ProductBlock | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT pb.id, pb.product_id, pb.type, pb.title, pb.blockquot,
           pb.author_designer_id, pb.body, pb.image_key, pb.tabs, pb.sort,
           pb.translations, pb.created_at,
           d.id AS d_id, d.slug AS d_slug, d.name AS d_name, d.image_key AS d_image_key
    FROM product_blocks pb
    LEFT JOIN designers d ON d.id = pb.author_designer_id
    WHERE pb.id = ${id} LIMIT 1
  `;
  return rows[0] ? mapProductBlock(rows[0]) : null;
}

/** Существует ли товар (для гварда перед вставкой секции). */
export async function productExists(productId: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM products WHERE id = ${productId}) AS ok
  `;
  return Boolean(rows[0]?.ok);
}

// -----------------------------------------------------------------------------
// Мутации (вызываются из actions с уже валидированным входом и переводами).
// -----------------------------------------------------------------------------

/** Данные записи секции (уже нормализованы; translations — итоговый оверлей). */
export interface BlockWriteData {
  id?: string;
  productId: string;
  type: ProductBlockType;
  title: string | null;
  blockquot: string | null;
  authorDesignerId: string | null;
  body: string | null;
  imageKey: string | null;
  tabs: ProductBlockTab[];
  sort: number | null;
  translations: TranslationsMap;
}

/**
 * Upsert секции: INSERT при отсутствии id, UPDATE при наличии. Возвращает id.
 *
 * ВАЖНО: image_key на UPDATE НЕ перезаписывается (картинка управляется отдельным
 * uploadProductBlockImage, как аватар дизайнера) — при апдейте формы её не теряем.
 * На INSERT sort=null → в хвост (max(sort)+1 внутри товара).
 */
export async function upsertBlock(data: BlockWriteData): Promise<{ id: string }> {
  const tabsJson = sql.json(data.tabs as unknown as Record<string, never>);
  const trJson = sql.json(data.translations as Record<string, never>);

  if (data.id) {
    const rows = await sql<{ id: string }[]>`
      UPDATE product_blocks SET
        type               = ${data.type},
        title              = ${data.title},
        blockquot          = ${data.blockquot},
        author_designer_id = ${data.authorDesignerId},
        body               = ${data.body},
        tabs               = ${tabsJson},
        sort               = COALESCE(${data.sort}, sort),
        translations       = ${trJson}
      WHERE id = ${data.id} AND product_id = ${data.productId}
      RETURNING id
    `;
    return rows[0] ?? { id: data.id };
  }

  const rows = await sql<{ id: string }[]>`
    INSERT INTO product_blocks
      (product_id, type, title, blockquot, author_designer_id, body, image_key,
       tabs, sort, translations)
    VALUES (
      ${data.productId}, ${data.type}, ${data.title}, ${data.blockquot},
      ${data.authorDesignerId}, ${data.body}, ${data.imageKey},
      ${tabsJson},
      COALESCE(${data.sort}, (
        SELECT COALESCE(MAX(sort) + 1, 0) FROM product_blocks WHERE product_id = ${data.productId}
      )),
      ${trJson}
    )
    RETURNING id
  `;
  return rows[0]!;
}

/**
 * Переупорядочивание секций товара: назначает sort по индексу в order (в одной
 * транзакции). Чужие product_id не трогаются (WHERE product_id).
 */
export async function reorderBlocks(productId: string, order: string[]): Promise<void> {
  await sql.begin(async (tx: TransactionSql) => {
    for (let i = 0; i < order.length; i++) {
      await tx`
        UPDATE product_blocks SET sort = ${i}
        WHERE id = ${order[i]!} AND product_id = ${productId}
      `;
    }
  });
}

/** Обновляет только image_key секции (загрузка картинки). Возвращает прежний ключ. */
export async function setBlockImageKey(
  id: string,
  imageKey: string,
): Promise<{ previousKey: string | null } | null> {
  const rows = await sql<{ prev: string | null }[]>`
    WITH prev AS (SELECT image_key FROM product_blocks WHERE id = ${id})
    UPDATE product_blocks SET image_key = ${imageKey}
    WHERE id = ${id}
    RETURNING (SELECT image_key FROM prev) AS prev
  `;
  return rows[0] ? { previousKey: rows[0].prev } : null;
}

/** Удаляет секцию; возвращает её image_key для очистки хранилища, или null. */
export async function deleteBlock(id: string): Promise<{ imageKey: string | null } | null> {
  const rows = await sql<{ image_key: string | null }[]>`
    DELETE FROM product_blocks WHERE id = ${id} RETURNING image_key
  `;
  return rows[0] ? { imageKey: rows[0].image_key } : null;
}
