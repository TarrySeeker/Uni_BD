/**
 * Публичный API модуля payments/tbank (docs/15 §2 «index.ts»). Реэкспорт того,
 * что нужно роутам/сервисам, без вытягивания внутренних деталей.
 */

export { getTbankConfig, isTbankMock, type TbankConfig } from './config';
export { getTbankManager, TbankManager, resetTbankManager } from './manager';
export { TbankError } from './errors';
export { signToken, verifyNotificationToken, buildTokenSource } from './token';
export { mapTbankStatus, STATUS_TO_PAYMENT_STATUS } from './status-map';
export { buildReceipt, receiptTotalKop, toKopecks } from './receipt';
export {
  PaymentService,
  parseNotification,
  sanitizeNotification,
  type ReconcilePaymentResult,
  type RefundPaymentResult,
} from './service';
export {
  runReconcilePending,
  findPendingTbankPayments,
  RECONCILE_PENDING_LIMIT,
  type PendingPaymentCandidate,
  type ReconcileStats,
  type ReconcileDeps,
} from './cron';
export {
  applyPaymentStatus,
  insertPaymentLog,
  markPaymentLogProcessed,
  setPaymentRefAndProvider,
} from './repository';
export type {
  InitPaymentResult,
  HandleWebhookResult,
  TbankEvent,
  TbankStatus,
  TbankPayType,
  TbankInitRequest,
  TbankInitResponse,
  TbankNotification,
} from './types';
