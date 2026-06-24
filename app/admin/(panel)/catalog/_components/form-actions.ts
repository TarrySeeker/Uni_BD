'use server';

import {
  createProduct,
  updateProduct,
  archiveProduct,
  deleteProduct,
  bulkSetProductStatus,
  duplicateProduct,
  createVariant,
  updateVariant,
  deleteVariant,
  setProductAttributes,
  attachMedia,
  deleteMedia,
  reorderMedia,
  setInventory,
  createBrand,
  updateBrand,
  deleteBrand,
  uploadBrandLogo,
  createCategory,
  updateCategory,
  moveCategory,
  deleteCategory,
} from '@/lib/catalog/actions';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions каталога (lib/catalog/actions).
 *
 * Назначение: дать клиентским формам ('use client') стабильные серверные
 * функции, которые можно импортировать и вызывать напрямую. Бизнес-логика,
 * guard (catalog.write), Zod-валидация, аудит и инвалидация — всё внутри
 * defineAction в lib/catalog/actions; здесь НЕ дублируется, только проксируется.
 *
 * Медиа/лого принимают FormData (файл нельзя сериализовать как обычный объект):
 * читаем bytes в Buffer на сервере и передаём в соответствующий Action.
 */

// --- Товары -----------------------------------------------------------------

export async function createProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createProduct(input);
}
export async function updateProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateProduct(input);
}
export async function archiveProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return archiveProduct(input);
}
export async function deleteProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteProduct(input);
}
export async function bulkSetProductStatusAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return bulkSetProductStatus(input);
}
export async function duplicateProductAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return duplicateProduct(input);
}

// --- Варианты ---------------------------------------------------------------

export async function createVariantAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createVariant(input);
}
export async function updateVariantAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateVariant(input);
}
export async function deleteVariantAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteVariant(input);
}

// --- Характеристики ---------------------------------------------------------

export async function setProductAttributesAction(
  input: unknown,
): Promise<ActionResult<{ productId: string }>> {
  return setProductAttributes(input) as Promise<ActionResult<{ productId: string }>>;
}

// --- Остатки ----------------------------------------------------------------

export async function setInventoryAction(
  input: unknown,
): Promise<ActionResult<{ id: string; quantity: number }>> {
  return setInventory(input);
}

// --- Медиа ------------------------------------------------------------------

/** Загрузка медиа товара из FormData (поле `file`, опц. `alt`, `isPrimary`). */
export async function uploadMediaAction(
  productId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; url: string; key: string }>> {
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'validation', fieldErrors: { file: ['Файл не выбран.'] } };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return attachMedia({
    productId,
    filename: file.name,
    bytes,
    alt: String(formData.get('alt') ?? ''),
    isPrimary: formData.get('isPrimary') === 'on' || formData.get('isPrimary') === 'true',
  });
}

export async function deleteMediaAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteMedia(input);
}
export async function reorderMediaAction(
  input: unknown,
): Promise<ActionResult<{ productId: string }>> {
  return reorderMedia(input);
}

// --- Бренды -----------------------------------------------------------------

export async function createBrandAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createBrand(input);
}
export async function updateBrandAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateBrand(input);
}
export async function deleteBrandAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteBrand(input);
}

/** Загрузка логотипа бренда из FormData (поле `file`). */
export async function uploadBrandLogoAction(
  brandId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; url: string; key: string }>> {
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'validation', fieldErrors: { file: ['Файл не выбран.'] } };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  return uploadBrandLogo({ brandId, filename: file.name, bytes });
}

// --- Категории --------------------------------------------------------------

export async function createCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return createCategory(input);
}
export async function updateCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateCategory(input);
}
export async function moveCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return moveCategory(input);
}
export async function deleteCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return deleteCategory(input);
}
