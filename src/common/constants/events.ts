/**
 * Domain event types for AgncyPay event bus.
 */
export enum AgncyPayEvent {
  // Payment events
  PAYMENT_RECEIVED = 'payment.received',
  PAYMENT_SETTLED = 'payment.settled',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_REFUNDED = 'payment.refunded',
  PAYMENT_CHARGEBACKED = 'payment.chargebacked',

  // Ledger events
  LEDGER_TRANSACTION_POSTED = 'ledger.posted',
  LEDGER_TRANSACTION_FAILED = 'ledger.failed',
  LEDGER_INVARIANT_VIOLATION = 'ledger.invariant.violation',

  // Payout events
  PAYOUT_INITIATED = 'payout.initiated',
  PAYOUT_SUBMITTED = 'payout.submitted',
  PAYOUT_COMPLETED = 'payout.completed',
  PAYOUT_FAILED = 'payout.failed',
  PAYOUT_RETURNED = 'payout.returned',

  // Credit events
  CREDIT_APPLIED = 'credit.applied',
  CREDIT_REPAID = 'credit.repaid',
  CREDIT_LINE_CREATED = 'credit.line.created',
  CREDIT_LINE_FROZEN = 'credit.line.frozen',
  CREDIT_EXPOSURE_EXCEEDED = 'credit.exposure.exceeded',

  // Risk events
  RISK_ASSESSMENT_COMPLETED = 'risk.assessment.completed',

  // Reconciliation events
  RECONCILIATION_MATCHED = 'reconciliation.matched',
  RECONCILIATION_MISMATCHED = 'reconciliation.mismatched',
  RECONCILIATION_FAILED = 'reconciliation.failed',

  // Wallet events
  WALLET_CREATED = 'wallet.created',
  WALLET_MAPPED = 'wallet.mapped',

  // Integration events
  QUICKBOOKS_INVOICE_RECEIVED = 'quickbooks.invoice.received',
  QUICKBOOKS_WEBHOOK_DUPLICATE = 'quickbooks.webhook.duplicate',
}

/**
 * Base event payload structure for audit trail.
 */
export interface BaseEventPayload {
  eventId: string;
  timestamp: string;
  source: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentEventPayload extends BaseEventPayload {
  paymentId: string;
  walletId: string;
  amount: string;
  currency: string;
  status: string;
}

export interface LedgerEventPayload extends BaseEventPayload {
  transactionId: string;
  referenceId: string;
  referenceType: string;
  entryCount: number;
}

export interface PayoutEventPayload extends BaseEventPayload {
  payoutId: string;
  walletId: string;
  amount: string;
  currency: string;
  bankReference?: string;
}

export interface CreditEventPayload extends BaseEventPayload {
  creditLineId: string;
  walletId: string;
  amount: string;
  usedAmount?: string;
  maxAmount?: string;
}

export interface ReconciliationEventPayload extends BaseEventPayload {
  reconciliationId: string;
  entityType: string;
  entityId: string;
  discrepancy?: string;
}
