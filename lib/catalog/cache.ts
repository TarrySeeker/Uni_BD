/**
 * Сборка презентационного кеша характеристик (ADR-007, docs/05 §2.2, §4.5).
 *
 * Источник истины — product_attributes (EAV). products.attributes_cache —
 * денормализованная JSONB-проекция для быстрого чтения карточки/списка.
 * Пересобирается в том же Server Action, что меняет характеристики.
 */

import { sql } from '@/lib/db/client';

/**
 * Строка для сборки кеша: код атрибута + читаемое значение.
 */
export interface AttributeCacheRow {
  code: string;
  value: string;
}

/**
 * Чистая функция: превращает список (code,value) в объект кеша
 * `{ [code]: value | value[] }`. Несколько значений одного кода → массив.
 */
export function buildAttributesCache(
  rows: AttributeCacheRow[],
): Record<string, string | string[]> {
  const acc: Record<string, string | string[]> = {};
  for (const { code, value } of rows) {
    const existing = acc[code];
    if (existing === undefined) {
      acc[code] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      acc[code] = [existing, value];
    }
  }
  return acc;
}

/**
 * Пересобирает products.attributes_cache из product_attributes (только уровень
 * товара, variant_id IS NULL). Читает читаемые значения (словарь или value_text),
 * собирает JSONB и пишет в products. Возвращает собранный кеш.
 */
export async function rebuildProductAttributesCache(
  productId: string,
): Promise<Record<string, string | string[]>> {
  const rows = await sql<{ code: string; value: string }[]>`
    SELECT a.code AS code,
           COALESCE(av.value, pa.value_text) AS value
    FROM product_attributes pa
    JOIN attributes a ON a.id = pa.attribute_id
    LEFT JOIN attribute_values av ON av.id = pa.value_id
    WHERE pa.product_id = ${productId} AND pa.variant_id IS NULL
  `;
  const cache = buildAttributesCache(
    rows
      .filter((r) => r.value !== null && r.value !== undefined)
      .map((r) => ({ code: r.code, value: r.value })),
  );
  await sql`
    UPDATE products SET attributes_cache = ${sql.json(cache)}, updated_at = now()
    WHERE id = ${productId}
  `;
  return cache;
}

/**
 * Пересобирает product_variants.attributes_cache из product_attributes для
 * переданных вариантов (variant-уровень EAV, variant_id NOT NULL). Зеркало
 * rebuildProductAttributesCache, но по variant_id (C10-1, ADR-007).
 *
 * Пишет КАЖДОМУ варианту из `variantIds` его собственный кеш; вариант без
 * EAV-строк получает пустой `{}` (стирание стейла — иначе после удаления всех
 * характеристик варианта витрина отдавала бы прежние значения). Возвращает
 * map variantId → собранный кеш.
 */
export async function rebuildVariantAttributesCache(
  productId: string,
  variantIds: string[],
): Promise<Record<string, Record<string, string | string[]>>> {
  if (variantIds.length === 0) {
    return {};
  }
  const rows = await sql<{ variant_id: string; code: string; value: string }[]>`
    SELECT pa.variant_id AS variant_id,
           a.code AS code,
           COALESCE(av.value, pa.value_text) AS value
    FROM product_attributes pa
    JOIN attributes a ON a.id = pa.attribute_id
    LEFT JOIN attribute_values av ON av.id = pa.value_id
    WHERE pa.product_id = ${productId}
      AND pa.variant_id = ANY(${variantIds}::uuid[])
  `;
  // Группируем читаемые значения по variant_id.
  const byVariant = new Map<string, AttributeCacheRow[]>();
  for (const r of rows) {
    if (r.value === null || r.value === undefined) {
      continue;
    }
    const list = byVariant.get(r.variant_id) ?? [];
    list.push({ code: r.code, value: r.value });
    byVariant.set(r.variant_id, list);
  }
  const result: Record<string, Record<string, string | string[]>> = {};
  // Пишем каждому ПЕРЕДАННОМУ варианту (пустой набор → {}, чистим стейл).
  for (const variantId of variantIds) {
    const cache = buildAttributesCache(byVariant.get(variantId) ?? []);
    await sql`
      UPDATE product_variants
      SET attributes_cache = ${sql.json(cache)}, updated_at = now()
      WHERE id = ${variantId}
    `;
    result[variantId] = cache;
  }
  return result;
}
