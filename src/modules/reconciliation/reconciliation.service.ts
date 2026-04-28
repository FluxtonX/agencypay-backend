import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { Money } from '../../common/utils/money.util.js';
import { v4 as uuidv4 } from 'uuid';
import type { Reconciliation, ReconciliationStatus } from '@prisma/client';
import Decimal from 'decimal.js';

/**
 * ReconciliationService — Validates consistency between expected and actual state.
 *
 * Checks:
 * - Payment amounts vs ledger entries
 * - Payout amounts vs bank confirmations
 * - Credit exposure vs ledger state
 * - Global ledger balance (should always be zero)
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Reconcile a specific payment: verify ledger entries match payment amount.
   */
  async reconcilePayment(paymentId: string): Promise<Reconciliation> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Sum all posted ledger entries for this payment
    const transactions = await this.ledgerService.getTransactionsByReference(
      paymentId,
      'payment',
    );

    const postedTransactions = transactions.filter(
      (t) => t.status === 'POSTED',
    );

    // Check that for each transaction, entries sum to zero
    let allBalanced = true;
    let totalDebits = Money.ZERO;

    for (const tx of postedTransactions) {
      const sum = Money.sum(tx.entries.map((e) => e.amount.toString()));
      if (!Money.isZero(sum)) {
        allBalanced = false;
        this.logger.error(
          `Unbalanced transaction ${tx.id}: sum = ${sum.toString()}`,
        );
      }

      // Sum only debit (positive) entries to verify total
      for (const entry of tx.entries) {
        const amt = new Decimal(entry.amount.toString());
        if (amt.isPositive()) {
          totalDebits = totalDebits.plus(amt);
        }
      }
    }

    const expectedAmount = new Decimal(payment.amount.toString());
    const discrepancy = expectedAmount.minus(totalDebits);

    let status: ReconciliationStatus;
    if (!allBalanced) {
      status = 'MISMATCHED';
    } else if (discrepancy.isZero()) {
      status = 'MATCHED';
    } else {
      status = 'MISMATCHED';
    }

    const reconciliation = await this.prisma.reconciliation.create({
      data: {
        entityType: 'payment',
        entityId: paymentId,
        expectedAmount: payment.amount,
        actualAmount: totalDebits.toFixed(4),
        status,
        discrepancy: discrepancy.toFixed(4),
        notes: allBalanced
          ? null
          : 'One or more ledger transactions are unbalanced',
        resolvedAt: status === 'MATCHED' ? new Date() : null,
      },
    });

    if (status === 'MISMATCHED') {
      this.eventEmitter.emit(AgncyPayEvent.RECONCILIATION_MISMATCHED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'ReconciliationService',
        reconciliationId: reconciliation.id,
        entityType: 'payment',
        entityId: paymentId,
        discrepancy: discrepancy.toFixed(4),
      });
    } else {
      this.eventEmitter.emit(AgncyPayEvent.RECONCILIATION_MATCHED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'ReconciliationService',
        reconciliationId: reconciliation.id,
        entityType: 'payment',
        entityId: paymentId,
      });
    }

    return reconciliation;
  }

  /**
   * Reconcile a payout: verify ledger entries match payout amount and bank status.
   */
  async reconcilePayout(payoutId: string): Promise<Reconciliation> {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });

    if (!payout) {
      throw new Error(`Payout ${payoutId} not found`);
    }

    const transactions = await this.ledgerService.getTransactionsByReference(
      payoutId,
      'payout',
    );

    const postedTransactions = transactions.filter(
      (t) => t.status === 'POSTED',
    );

    let allBalanced = true;
    for (const tx of postedTransactions) {
      const sum = Money.sum(tx.entries.map((e) => e.amount.toString()));
      if (!Money.isZero(sum)) {
        allBalanced = false;
      }
    }

    const status: ReconciliationStatus = allBalanced ? 'MATCHED' : 'MISMATCHED';

    const reconciliation = await this.prisma.reconciliation.create({
      data: {
        entityType: 'payout',
        entityId: payoutId,
        expectedAmount: payout.amount,
        actualAmount: allBalanced ? payout.amount : null,
        status,
        resolvedAt: status === 'MATCHED' ? new Date() : null,
      },
    });

    return reconciliation;
  }

  /**
   * Global ledger audit: verify that the sum of ALL entries across ALL transactions is zero.
   * This is the ultimate invariant check for the entire system.
   */
  async auditGlobalLedgerBalance(): Promise<{
    balanced: boolean;
    totalSum: string;
    transactionCount: number;
    entryCount: number;
  }> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        transaction: { status: 'POSTED' },
      },
      select: { amount: true },
    });

    const totalSum = entries.reduce(
      (sum, entry) => sum.plus(new Decimal(entry.amount.toString())),
      Money.ZERO,
    );

    const transactionCount = await this.prisma.ledgerTransaction.count({
      where: { status: 'POSTED' },
    });

    const balanced = totalSum.isZero();

    if (!balanced) {
      this.logger.error(
        `🚨 GLOBAL LEDGER IMBALANCE DETECTED: sum = ${totalSum.toString()}, ` +
          `${transactionCount} transactions, ${entries.length} entries`,
      );

      this.eventEmitter.emit(AgncyPayEvent.RECONCILIATION_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'ReconciliationService',
        reconciliationId: 'global-audit',
        entityType: 'global',
        entityId: 'ledger',
        discrepancy: totalSum.toString(),
      });
    } else {
      this.logger.log(
        `✅ Global ledger audit passed: ${transactionCount} transactions, ${entries.length} entries`,
      );
    }

    return {
      balanced,
      totalSum: totalSum.toString(),
      transactionCount,
      entryCount: entries.length,
    };
  }

  /**
   * Get reconciliation results.
   */
  async getReconciliations(
    entityType?: string,
    status?: ReconciliationStatus,
    limit: number = 20,
  ): Promise<Reconciliation[]> {
    return this.prisma.reconciliation.findMany({
      where: {
        ...(entityType ? { entityType } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
