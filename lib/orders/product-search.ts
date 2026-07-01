'use server';

import { z } from 'zod';

import { defineAction } from '@/lib/server/action';
import { getProductById, listProducts } from '@/lib/catalog/repository';

import { effectiveUnitPriceMinor } from './pricing';
import { fromMinor } from './money';

/**
 * Read-only поиск товаров для подбора позиций в ручном заказе (Batch 4, F4).
 *
 * Переиспользует listProducts/getProductById каталога — НЕ дублирует листинг.
 * Гейт — право orders.write (оператор, создающий заказ, уже им обладает; не
 * плодим отдельное право). Отдаёт компактный DTO: товар + его активные варианты
 * с ЭФФЕКТИВНОЙ ценой продажи за единицу (для предпросмотра в форме).
 *
 * Цены здесь — справочные для UI. Источник правды по цене/остатку/резерву —
 * сервер при createManualOrder (ADR-010); форма деньги не считает.
 */

const SearchInputSchema = z.object({
  /** Строка поиска по названию/SKU (ILIKE через listProducts). */
  q: z.string().trim().max(200).optional(),
  /** Сколько товаров вернуть (по умолчанию 10, максимум 25). */
  limit: z.number().int().min(1).max(25).optional(),
});

/** Вариант товара для выбора в позицию заказа. */
export interface OrderProductVariantOption {
  variantId: string;
  sku: string;
  name: string;
  /** Эффективная цена продажи за единицу (строка-сумма) — для предпросмотра. */
  unitPrice: string;
}

/** Товар-кандидат для позиции заказа. */
export interface OrderProductOption {
  productId: string;
  sku: string;
  name: string;
  /** Базовая цена товара (строка-сумма) — для товара без вариантов. */
  basePrice: string;
  /** Эффективная цена за единицу товара без вариантов (= basePrice). */
  unitPrice: string;
  /** Доступно к продаже (quantity − reserved) по складу main. */
  availableStock: number;
  /** Активные варианты товара (если есть). */
  variants: OrderProductVariantOption[];
}

/**
 * Поиск товаров для формы. Берёт первые N активных товаров по строке поиска,
 * затем дочитывает варианты каждого через getProductById (карточка). Возвращает
 * только активные варианты с посчитанной эффективной ценой.
 */
export const searchProductsForOrder = defineAction({
  permission: 'orders.write',
  input: SearchInputSchema,
  handler: async (data) => {
    const limit = data.limit ?? 10;
    const { rows } = await listProducts({
      search: data.q,
      status: 'active',
      page: 1,
      pageSize: limit,
      sort: 'name_asc',
    });

    const options: OrderProductOption[] = [];
    for (const row of rows) {
      const detail = await getProductById(row.id);
      const variants: OrderProductVariantOption[] = (detail?.variants ?? [])
        .filter((v) => v.isActive)
        .map((v) => ({
          variantId: v.id,
          sku: v.sku,
          name: v.name,
          unitPrice: fromMinor(
            effectiveUnitPriceMinor({
              basePrice: row.basePrice,
              priceOverride: v.priceOverride,
              priceDelta: v.priceDelta,
            }),
          ),
        }));

      options.push({
        productId: row.id,
        sku: row.sku,
        name: row.name,
        basePrice: row.basePrice,
        unitPrice: fromMinor(effectiveUnitPriceMinor({ basePrice: row.basePrice })),
        availableStock: row.availableStock,
        variants,
      });
    }

    return {
      result: { products: options },
    };
  },
});
