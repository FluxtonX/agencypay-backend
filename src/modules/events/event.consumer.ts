import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import type {
  PaymentEventPayload,
  LedgerEventPayload,
  PayoutEventPayload,
  CreditEventPayload,
  ReconciliationEventPayload,
  BaseEventPayload,
} from '../../common/constants/events.js';

/**
 * EventConsumer — Handles domain events for side effects, logging, and downstream processing.
 *
 * This is the in-memory event bus consumer. In production, events would be
 * published to SNS/SQS for durability and cross-service consumption.
 *
 * Each handler is idempotent and non-blocking.
 */
@Injectable()
export class EventConsumer {
  private readonly logger = new Logger(EventConsumer.name);

  constructor(private readonly ingestionService: IngestionService) {}

  // ====================================
  // PAYMENT EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.PAYMENT_SETTLED)
  handlePaymentSettled(payload: PaymentEventPayload) {
    this.logger.log(
      `📥 [EVENT] Payment settled: ${payload.paymentId} — ` +
        `${payload.amount} ${payload.currency} — wallet: ${payload.walletId}`,
    );
    // Future: Trigger credit reconciliation, notifications, etc.
  }

  @OnEvent(AgncyPayEvent.PAYMENT_FAILED)
  handlePaymentFailed(payload: PaymentEventPayload & { error?: string }) {
    this.logger.warn(
      `❌ [EVENT] Payment failed: ${payload.paymentId} — ${payload.error}`,
    );
    // Future: Alert ops, retry logic
  }

  @OnEvent(AgncyPayEvent.PAYMENT_REFUNDED)
  handlePaymentRefunded(payload: PaymentEventPayload) {
    this.logger.log(
      `💸 [EVENT] Payment refunded: ${payload.paymentId} — ${payload.amount}`,
    );
  }

  @OnEvent(AgncyPayEvent.PAYMENT_CHARGEBACKED)
  handlePaymentChargebacked(payload: PaymentEventPayload) {
    this.logger.warn(
      `⚠️ [EVENT] Chargeback: ${payload.paymentId} — ${payload.amount}`,
    );
    // Future: Risk flag, credit line freeze
  }

  // ====================================
  // LEDGER EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.LEDGER_TRANSACTION_POSTED)
  handleLedgerPosted(payload: LedgerEventPayload) {
    this.logger.log(
      `📒 [EVENT] Ledger posted: ${payload.transactionId} — ` +
        `ref: ${payload.referenceId} (${payload.referenceType}), ` +
        `${payload.entryCount} entries`,
    );
  }

  @OnEvent(AgncyPayEvent.LEDGER_TRANSACTION_FAILED)
  handleLedgerFailed(payload: LedgerEventPayload & { error?: string }) {
    this.logger.error(
      `🚨 [EVENT] Ledger failed: ref ${payload.referenceId} — ${payload.error}`,
    );
  }

  @OnEvent(AgncyPayEvent.LEDGER_INVARIANT_VIOLATION)
  handleInvariantViolation(
    payload: BaseEventPayload & { sum: string; entries: unknown[] },
  ) {
    this.logger.error(
      `🚨🚨 [EVENT] LEDGER INVARIANT VIOLATION! Sum: ${payload.sum}`,
    );
    // CRITICAL: This should page on-call in production
  }

  // ====================================
  // PAYOUT EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.PAYOUT_SUBMITTED)
  handlePayoutSubmitted(
    payload: PayoutEventPayload & { bankReference?: string },
  ) {
    this.logger.log(
      `🏦 [EVENT] Payout submitted: ${payload.payoutId} — ` +
        `${payload.amount} ${payload.currency} — bank ref: ${payload.bankReference}`,
    );
  }

  @OnEvent(AgncyPayEvent.PAYOUT_COMPLETED)
  handlePayoutCompleted(payload: PayoutEventPayload) {
    this.logger.log(
      `✅ [EVENT] Payout completed: ${payload.payoutId} — ${payload.amount}`,
    );
  }

  @OnEvent(AgncyPayEvent.PAYOUT_FAILED)
  handlePayoutFailed(
    payload: PayoutEventPayload & { error?: string; failureReason?: string },
  ) {
    this.logger.error(
      `❌ [EVENT] Payout failed: ${payload.payoutId} — ${payload.error || payload.failureReason}`,
    );
  }

  @OnEvent(AgncyPayEvent.PAYOUT_RETURNED)
  handlePayoutReturned(
    payload: PayoutEventPayload & { failureReason?: string },
  ) {
    this.logger.warn(
      `↩️ [EVENT] Payout returned: ${payload.payoutId} — ${payload.failureReason}`,
    );
  }

  // ====================================
  // CREDIT EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.CREDIT_APPLIED)
  handleCreditApplied(payload: CreditEventPayload) {
    this.logger.log(
      `💳 [EVENT] Credit applied: ${payload.amount} — wallet: ${payload.walletId} ` +
        `(used: ${payload.usedAmount}/${payload.maxAmount})`,
    );
  }

  @OnEvent(AgncyPayEvent.CREDIT_REPAID)
  handleCreditRepaid(payload: CreditEventPayload) {
    this.logger.log(
      `✅ [EVENT] Credit repaid: ${payload.amount} — wallet: ${payload.walletId}`,
    );
  }

  @OnEvent(AgncyPayEvent.CREDIT_LINE_CREATED)
  handleCreditLineCreated(
    payload: CreditEventPayload & { maxAmount?: string },
  ) {
    this.logger.log(
      `🆕 [EVENT] Credit line created: ${payload.creditLineId} — ` +
        `max: ${payload.maxAmount}`,
    );
  }

  @OnEvent(AgncyPayEvent.CREDIT_LINE_FROZEN)
  handleCreditLineFrozen(
    payload: CreditEventPayload & { reason?: string },
  ) {
    this.logger.warn(
      `🧊 [EVENT] Credit line frozen: ${payload.creditLineId} — ${payload.reason}`,
    );
  }

  // ====================================
  // RISK EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.RISK_ASSESSMENT_COMPLETED)
  handleRiskAssessment(
    payload: BaseEventPayload & {
      walletId: string;
      score: number;
      decision: string;
    },
  ) {
    this.logger.log(
      `🎯 [EVENT] Risk assessment: wallet ${payload.walletId} — ` +
        `score: ${payload.score}, decision: ${payload.decision}`,
    );
  }

  // ====================================
  // RECONCILIATION EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.RECONCILIATION_MISMATCHED)
  handleReconciliationMismatch(payload: ReconciliationEventPayload) {
    this.logger.error(
      `⚠️ [EVENT] Reconciliation mismatch: ${payload.entityType} ${payload.entityId} ` +
        `— discrepancy: ${payload.discrepancy}`,
    );
  }

  @OnEvent(AgncyPayEvent.RECONCILIATION_FAILED)
  handleReconciliationFailed(payload: ReconciliationEventPayload) {
    this.logger.error(
      `🚨 [EVENT] Reconciliation failed: ${payload.entityType} ${payload.entityId}`,
    );
  }

  // ====================================
  // WALLET EVENTS
  // ====================================

  @OnEvent(AgncyPayEvent.WALLET_CREATED)
  handleWalletCreated(
    payload: BaseEventPayload & { walletId: string; type: string },
  ) {
    this.logger.log(
      `🆕 [EVENT] Wallet created: ${payload.walletId} (${payload.type})`,
    );
  }

  // ====================================
  // QUICKBOOKS EVENTS
  // ====================================
  
  @OnEvent(AgncyPayEvent.QUICKBOOKS_INVOICE_RECEIVED)
  async handleQuickBooksInvoice(
    payload: BaseEventPayload & { realmId: string; invoiceId: string; invoice: any },
  ) {
    this.logger.log(
      `📄 [EVENT] QuickBooks invoice received: ${payload.invoiceId} (Realm: ${payload.realmId})`,
    );
    
    try {
      await this.ingestionService.ingestQuickBooksInvoice(payload.invoice, payload.realmId);
    } catch (error) {
      this.logger.error(`Failed to ingest QB invoice ${payload.invoiceId}: ${error.message}`);
    }
  }

  @OnEvent(AgncyPayEvent.QUICKBOOKS_WEBHOOK_DUPLICATE)
  handleQuickBooksDuplicate(
    payload: BaseEventPayload & { dedupeKey: string },
  ) {
    this.logger.debug(
      `🔄 [EVENT] Duplicate QuickBooks webhook: ${payload.dedupeKey}`,
    );
  }
}
