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
  GiftIssueSource,
  GiftParty,
  GiftSettings,
  ResolvedGiftSettings,
} from './types';
export { GIFT_CERTIFICATE_STATUSES, GIFT_ISSUE_SOURCES, EMPTY_GIFT_PARTY } from './types';

export {
  GIFT_ITEM_MARKER_KEYS,
  GIFT_CODE_ALPHABET,
  GIFT_VALID_DAYS_KEYS,
  buildGiftCodeForOrderItem,
  certificateItemHint,
  giftFaceValueFromItem,
  giftValidDaysFor,
  giftValidUntil,
  isGiftItemForAutoIssue,
  looksLikeCertificateItem,
  normalizeGiftParty,
  isGiftPartyEmpty,
  randomGiftCode,
  type CertificateSourceItem,
  type GiftPartyInput,
} from './origin';

export {
  autoIssueGiftsForPaidOrder,
  createGiftAutoIssuer,
  productionAutoIssueDeps,
  type AutoIssueDeps,
  type AutoIssueItemOutcome,
  type AutoIssueReport,
  type AutoIssueSkipReason,
} from './auto-issue';

export {
  GIFT_EXPIRE_TASK,
  expiredGiftStatus,
  reviveStatusAfterTopUp,
  type ExpireInput,
  type ReviveInput,
} from './lifecycle';

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
  giftPartySchema,
  IssueGiftCertificateSchema,
  IssueGiftFromOrderSchema,
  type IssueGiftFromOrderInput,
  UpdateGiftCertificateSchema,
  SetGiftStatusSchema,
  applyGiftCodeSchema,
  type IssueGiftCertificateInput,
  type UpdateGiftCertificateInput,
  type SetGiftStatusInput,
} from './schemas';

export {
  mapGiftCertificate,
  mapGiftParty,
  mapRedemption,
  findByCode,
  getGiftCertificateById,
  getBalance,
  listGiftCertificates,
  listGiftCertificatesIssuedForOrder,
  getOrderItemForGiftIssue,
  countGiftCertificates,
  getRedemptions,
  insertGiftCertificate,
  updateGiftStatus,
  redeemGiftTx,
  releaseGiftTx,
  redeemGift,
  releaseGift,
  getOrderForAutoIssue,
  insertGiftCertificateTx,
  lockOrderForGiftIssueTx,
  revokeIssuedGiftsTx,
  findOrdersPendingGiftIssue,
  markExpiredGiftCertificates,
  type RedeemResult,
  type ReleaseResult,
  type IssueGiftCertificateRow,
  type GiftIssueSourceRow,
  type AutoIssueOrderSnapshot,
  type IssuedGiftRef,
  type RevokedGiftRef,
  type RevokeIssuedGiftsResult,
  type PendingGiftIssueOrder,
} from './repository';

export {
  createGiftActions,
  productionGiftDeps,
  issueGiftCertificate,
  updateGiftCertificate,
  setGiftStatus,
  issueGiftFromOrder,
  manualIssueGateReason,
  type GiftActionDeps,
  type ManualIssueGateReason,
  type ManualIssueOrderGate,
} from './actions';
