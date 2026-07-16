/**
 * Публичный API модуля payments/alfabank. Реэкспорт того, что нужно роутам/сервисам/
 * диспетчеру, без вытягивания внутренних деталей (порт paykeeper/index.ts).
 */

export {
  getAlfabankConfig,
  isAlfabankMock,
  parseCsvStrings,
  type AlfabankConfig,
} from './config';
export {
  getAlfabankManager,
  AlfabankManager,
  resetAlfabankManager,
} from './manager';
export { AlfabankError } from './errors';
export { verifyCallbackChecksum, signCallback } from './token';
export {
  mapOrderStatus,
  mapCallbackOperation,
  ORDER_STATUS_TO_PAYMENT_STATUS,
} from './status-map';
export {
  PaymentService,
  parseCallback,
  sanitizeCallback,
  type ReconcilePaymentResult,
  type RefundPaymentResult,
} from './service';
export {
  runReconcilePending,
  findPendingAlfabankPayments,
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
  findOrderIdByRef,
  getOrderGrandTotalById,
  recordWebhookEvent,
} from './repository';
export {
  AlfabankClient,
  type IAlfabankClient,
  type AlfabankClientOptions,
} from './client';
export type {
  InitPaymentResult,
  HandleCallbackResult,
  AlfabankEvent,
  AlfabankOrderStatus,
  AlfabankOperation,
  AlfabankCallbackParams,
  RegisterOrderInput,
  RegisterOrderResult,
  OrderStatusResult,
  RefundResult,
} from './types';
