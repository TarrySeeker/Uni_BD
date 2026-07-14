/**
 * Срез «Подарочные сертификаты-баланс» (docs/24 §5) — реэкспорт публичного API.
 *
 * Балансовый инструмент: номинал списывается частично по нескольким заказам,
 * хранится остаток. Схема — миграции 0039–0041. ГРАНИЦА 4a: домен + схема +
 * админка; интеграция в quote/createOrder/refund — 4b.
 */

export type {
  GiftCertificate,
  GiftCertificateRedemption,
  GiftCertificateStatus,
} from './types';
export { GIFT_CERTIFICATE_STATUSES } from './types';

export { GIFT_TR_FIELDS } from './fields';

export {
  GiftCertificateError,
  GiftOverspendError,
  type GiftErrorCode,
} from './errors';

export {
  remainingMinor,
  computeRemaining,
  computeApplicableMinor,
  computeApplicable,
  isRedeemable,
  certRemaining,
  type RedeemableCheck,
} from './balance';

export {
  assertRedeemable,
  computeApplicableAmount,
  resolveGiftApplication,
  type GiftApplication,
} from './service';

export {
  giftCodeSchema,
  giftFaceValueSchema,
  IssueGiftCertificateSchema,
  UpdateGiftCertificateSchema,
  SetGiftStatusSchema,
  applyGiftCodeSchema,
  type IssueGiftCertificateInput,
  type UpdateGiftCertificateInput,
  type SetGiftStatusInput,
} from './schemas';

export {
  mapGiftCertificate,
  mapRedemption,
  findByCode,
  getGiftCertificateById,
  getBalance,
  listGiftCertificates,
  countGiftCertificates,
  getRedemptions,
  insertGiftCertificate,
  updateGiftStatus,
  redeemGiftTx,
  releaseGiftTx,
  redeemGift,
  releaseGift,
  type RedeemResult,
  type ReleaseResult,
  type IssueGiftCertificateRow,
} from './repository';

export {
  createGiftActions,
  productionGiftDeps,
  issueGiftCertificate,
  updateGiftCertificate,
  setGiftStatus,
  type GiftActionDeps,
} from './actions';
