/**
 * Публичный API среза дизайнеров (§9, ADR §4.4). Реэкспорт домена.
 * Мутации (actions.ts) импортируются напрямую из './actions' ('use server').
 */

export type { Designer, DesignerRef, DesignerSocials } from './types';
export {
  mapDesigner,
  listDesigners,
  getDesignerById,
  getDesignerBySlug,
  getActiveDesignerBySlug,
} from './repository';
export {
  DesignerCreateSchema,
  DesignerUpdateSchema,
  DesignerIdSchema,
  DesignerSetActiveSchema,
  DesignerImageUploadSchema,
  type DesignerCreateInput,
  type DesignerUpdateInput,
  type DesignerImageUploadInput,
} from './schemas';
export { DesignerError } from './errors';
