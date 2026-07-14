'use server';

import { defineAction } from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { getLocaleConfig } from '@/lib/i18n';
import { getStorage } from '@/lib/storage';
import { validateUpload } from '@/lib/storage/validate';
import { generatePreviews } from '@/lib/storage/image';

import {
  UpsertProductBlockSchema,
  ReorderProductBlocksSchema,
  ProductBlockIdSchema,
  ProductBlockImageUploadSchema,
} from './schemas';
import {
  upsertBlock,
  reorderBlocks,
  deleteBlock,
  getBlockById,
  productExists,
  setBlockImageKey,
} from './repository';
import { buildBlockTranslations } from './i18n';
import { ProductBlockError } from './errors';

/**
 * Server Actions структурных секций товара (product_blocks, §9). Секции живут под
 * модулем catalog (assertCatalogEnabled); права те же catalog.read/write, что и у
 * товара/дизайнера — отдельного модуля/прав НЕ заводим (секция — часть карточки товара).
 *
 * Паттерн зеркалит designers/catalog: guard (catalog.write) → Zod → handler (sql,
 * параметризовано) → revalidate → audit. i18n-оверлей строится buildBlockTranslations
 * (whitelist title/blockquot/body + структурные tabs; только не-дефолтные языки).
 */

async function assertCatalogEnabled(): Promise<void> {
  if (!(await isModuleEffectivelyEnabled('catalog'))) {
    throw new ProductBlockError('module_disabled', 'Модуль «Каталог» выключен.');
  }
}

function productPath(productId: string): string {
  return `/admin/catalog/products/${productId}`;
}

/** Не-дефолтные языки магазина (в оверлей пишутся только они; база ru — в колонках). */
async function overlayLocales(): Promise<string[]> {
  const cfg = await getLocaleConfig();
  return cfg.locales.filter((l) => l !== cfg.defaultLocale);
}

// -----------------------------------------------------------------------------
// CRUD секций.
// -----------------------------------------------------------------------------

export const upsertProductBlock = defineAction({
  permission: 'catalog.write',
  input: UpsertProductBlockSchema,
  handler: async (data) => {
    await assertCatalogEnabled();

    let before: Record<string, unknown> | undefined;
    if (data.id) {
      const existing = await getBlockById(data.id);
      if (!existing || existing.productId !== data.productId) {
        throw new ProductBlockError('not_found', 'Секция не найдена.');
      }
      before = existing as unknown as Record<string, unknown>;
    } else if (!(await productExists(data.productId))) {
      throw new ProductBlockError('product_not_found', 'Товар не найден.');
    }

    const translations = buildBlockTranslations(data.translations, await overlayLocales());

    const row = await upsertBlock({
      id: data.id,
      productId: data.productId,
      type: data.type as never,
      title: data.title ?? null,
      blockquot: data.blockquot ?? null,
      authorDesignerId: data.authorDesignerId ?? null,
      body: data.body ?? null,
      imageKey: data.imageKey ?? null,
      tabs: data.tabs ?? [],
      sort: data.sort ?? null,
      translations,
    });

    return {
      result: { id: row.id },
      revalidate: [productPath(data.productId)],
      audit: {
        action: data.id ? 'catalog.product_block.update' : 'catalog.product_block.create',
        entityType: 'product_block',
        entityId: row.id,
        before,
        after: { productId: data.productId, type: data.type },
      },
    };
  },
});

export const reorderProductBlocks = defineAction({
  permission: 'catalog.write',
  input: ReorderProductBlocksSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    await reorderBlocks(data.productId, data.order);
    return {
      result: { productId: data.productId },
      revalidate: [productPath(data.productId)],
      audit: {
        action: 'catalog.product_block.reorder',
        entityType: 'product',
        entityId: data.productId,
        after: { order: data.order },
      },
    };
  },
});

export const deleteProductBlock = defineAction({
  permission: 'catalog.write',
  input: ProductBlockIdSchema,
  handler: async (data) => {
    await assertCatalogEnabled();
    const existing = await getBlockById(data.id);
    if (!existing) {
      throw new ProductBlockError('not_found', 'Секция не найдена.');
    }
    const removed = await deleteBlock(data.id);
    if (removed?.imageKey) {
      await getStorage().delete(removed.imageKey).catch(() => {});
    }
    return {
      result: { id: data.id },
      revalidate: [productPath(existing.productId)],
      audit: {
        action: 'catalog.product_block.delete',
        entityType: 'product_block',
        entityId: data.id,
        before: existing as unknown as Record<string, unknown>,
      },
    };
  },
});

export const uploadProductBlockImage = defineAction({
  permission: 'catalog.write',
  input: ProductBlockImageUploadSchema,
  handler: async (data) => {
    await assertCatalogEnabled();

    const block = await getBlockById(data.blockId);
    if (!block) {
      throw new ProductBlockError('not_found', 'Секция не найдена.');
    }

    const validation = await validateUpload(data.bytes, data.filename);
    if (!validation.ok || !validation.mime) {
      throw new ProductBlockError('invalid_media', validation.error ?? 'Недопустимый файл.');
    }

    const previews = await generatePreviews(data.bytes);
    const storage = getStorage();
    const key = `product-blocks/${data.blockId}/${crypto.randomUUID()}.webp`;
    let put;
    try {
      put = await storage.put(key, previews.main.buffer, 'image/webp');
    } catch {
      throw new ProductBlockError('storage_failed', 'Не удалось сохранить файл в хранилище.');
    }

    let prev;
    try {
      prev = await setBlockImageKey(data.blockId, put.key);
    } catch (err) {
      await storage.delete(put.key).catch(() => {});
      throw err;
    }
    if (prev?.previousKey && prev.previousKey !== put.key) {
      await storage.delete(prev.previousKey).catch(() => {});
    }

    return {
      result: { id: data.blockId, url: put.url, key: put.key },
      revalidate: [productPath(block.productId)],
      audit: {
        action: 'catalog.product_block.image.upload',
        entityType: 'product_block',
        entityId: data.blockId,
        after: { key: put.key },
      },
    };
  },
});
