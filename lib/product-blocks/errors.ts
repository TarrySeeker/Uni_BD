/** Доменные ошибки структурных секций товара (product_blocks, §9). */

export type ProductBlockErrorCode =
  | 'module_disabled'
  | 'not_found'
  | 'product_not_found'
  | 'invalid_media'
  | 'storage_failed';

/** Ошибка домена product-blocks с машиночитаемым кодом (для Server Actions). */
export class ProductBlockError extends Error {
  code: ProductBlockErrorCode;
  constructor(code: ProductBlockErrorCode, message: string) {
    super(message);
    this.name = 'ProductBlockError';
    this.code = code;
  }
}
