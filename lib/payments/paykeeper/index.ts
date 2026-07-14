/**
 * Публичный API модуля payments/paykeeper (docs/24 §2). Реэкспорт того, что нужно
 * роутам/сервисам/диспетчеру, без вытягивания внутренних деталей.
 */

export {
  getPaykeeperConfig,
  isPaykeeperMock,
  parseCsvStrings,
  type PaykeeperConfig,
} from './config';
export {
  getPaykeeperManager,
  PaykeeperManager,
  resetPaykeeperManager,
} from './manager';
export { PaykeeperError } from './errors';
export {
  verifyCallbackSignature,
  signCallback,
  buildCallbackAck,
  basicAuthHeader,
} from './token';
export { mapPaykeeperStatus, STATUS_TO_PAYMENT_STATUS } from './status-map';
export {
  PaymentService,
  parseCallback,
  sanitizeCallback,
  type ReconcilePaymentResult,
  type RefundPaymentResult,
} from './service';
export {
  runReconcilePending,
  findPendingPaykeeperPayments,
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
  findOrderIdByInvoiceId,
  getOrderGrandTotalById,
  recordWebhookEvent,
} from './repository';
export {
  PaykeeperClient,
  type IPaykeeperClient,
  type PaykeeperClientOptions,
} from './client';
export type {
  InitPaymentResult,
  HandleCallbackResult,
  PaykeeperEvent,
  PaykeeperStatus,
  PaykeeperCallbackParams,
  PaykeeperCartItem,
  CreateInvoiceInput,
  CreateInvoiceResult,
  InvoiceStatusResult,
} from './types';
