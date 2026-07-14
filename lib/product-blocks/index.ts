/**
 * Публичный API среза структурных секций товара (product_blocks, §9).
 * Порт eAdmin b_work_block: цитата с автором-дизайнером, табы, текст, картинка.
 */

export type {
  ProductBlock,
  ProductBlockTab,
  ProductBlockType,
} from './types';
export { PRODUCT_BLOCK_TYPES } from './types';

export {
  mapProductBlock,
  mapBlockAuthorRef,
  asTabs,
  listBlocksByProduct,
  getBlockById,
  productExists,
  upsertBlock,
  reorderBlocks,
  deleteBlock,
  setBlockImageKey,
  type BlockWriteData,
} from './repository';

export {
  UpsertProductBlockSchema,
  ReorderProductBlocksSchema,
  ProductBlockIdSchema,
  ProductBlockImageUploadSchema,
  ProductBlockTypeSchema,
  blockTabSchema,
  blockTabsSchema,
  blockTranslationsSchema,
  MAX_TABS,
  type UpsertProductBlockInput,
  type ReorderProductBlocksInput,
  type ProductBlockImageUploadInput,
} from './schemas';

export { buildBlockTranslations, localizeBlockTabs } from './i18n';

export { ProductBlockError, type ProductBlockErrorCode } from './errors';
