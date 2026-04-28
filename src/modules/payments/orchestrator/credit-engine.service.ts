import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../database/prisma.service.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { RiskAssessmentService } from './risk-assessment.service.js';
import { Money } from '../../../common/utils/money.util.js';
import { AgncyPayEvent } from '../../../common/constants/events.js';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import type { CreditLine, CreditUsage } from '@prisma/client';
import Decimal from 'decimal.js';

export interface CreditAdvanceResult {
  creditLine: CreditLine;
  usage: CreditUsage;
  ledgerTransactionId: string;
}

/**
 * CreditEngine — Net-0 Credit System.
 *
 * Enables early payouts BEFORE actual payment settlement.
 * When a payment arrives, it auto-reconciles against outstanding credit.
 *
 * Flow:
 * 1. Wallet requests early payout (credit advance)
 * 2. Risk assessment determines eligibility + amount
 * 3. If approved: create/extend credit line, post ledger entries
 * 4. When actual payment settles: auto-repay credit line
 * 5. If payment never settles: credit becomes recoverable debt
 */
@Injectable()
export class CreditEngine {
  private readonly logger = new Logger(CreditEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly riskService: RiskAssessmentService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Request a credit advance (early payout before settlement).
   */
  async requestCreditAdvance(
    walletId: string,
    requestedAmount: string,
    referenceId: string,
    currency: string = 'USD',
  ): Promise<CreditAdvanceResult> {
    // 1. Risk assessment
    const assessment = await this.riskService.assessRisk(
      walletId,
      requestedAmount,
    );

    if (assessment.decision === 'REJECT') {
      throw new BadRequestException(
        `Credit request rejected. Risk score: ${assessment.score}`,
      );
    }

    const approvedAmount = assessment.approvedAmount?.toString() || '0';

    if (Money.isZero(approvedAmount)) {
      throw new BadRequestException('Approved amount is zero');
    }

    // 2. Get or create credit line
    let creditLine = await this.prisma.creditLine.findUnique({
      where: {
        walletId_currency: {
          walletId,
          currency,
        },
      },
    });

    const maxExposure = this.config.get<number>(
      'credit.maxExposureMultiplier',
      0.8,
    );
    const interestRate = this.config.get<number>(
      'credit.defaultInterestRate',
      0.0,
    );

    if (!creditLine) {
      // Calculate max credit based on wallet's payment history
      const totalSettled = await this.prisma.payment.aggregate({
        where: { walletId, status: 'SETTLED' },
        _sum: { settledAmount: true },
      });

      const historicalVolume = totalSettled._sum.settledAmount
        ? new Decimal(totalSettled._sum.settledAmount.toString())
        : Money.ZERO;

      const maxAmount = Money.multiply(
        historicalVolume.toString(),
        maxExposure.toString(),
      );

      creditLine = await this.prisma.creditLine.create({
        data: {
          walletId,
          maxAmount: maxAmount.toFixed(4),
          usedAmount: '0',
          currency,
          interestRate: interestRate.toString(),
        },
      });

      this.eventEmitter.emit(AgncyPayEvent.CREDIT_LINE_CREATED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'CreditEngine',
        creditLineId: creditLine.id,
        walletId,
        maxAmount: maxAmount.toFixed(4),
      });
    }

    // 3. Check available credit
    const available = Money.subtract(
      creditLine.maxAmount.toString(),
      creditLine.usedAmount.toString(),
    );

    const effectiveAmount = Money.min(
      approvedAmount,
      available.toString(),
    );

    if (Money.isZero(effectiveAmount.toString()) || Money.isNegative(effectiveAmount.toString())) {
      throw new BadRequestException(
        `Credit limit exceeded. Available: ${available.toFixed(4)}, Max: ${creditLine.maxAmount.toString()}`,
      );
    }

    // 4. Get ledger accounts
    const creditAccount = await this.ledgerService.getAccountByType(
      walletId,
      'CREDIT',
      currency,
    );
    const payableAccount = await this.ledgerService.getAccountByType(
      walletId,
      'PAYABLE',
      currency,
    );

    if (!creditAccount || !payableAccount) {
      throw new BadRequestException(
        `Wallet ${walletId} missing CREDIT or PAYABLE account`,
      );
    }

    // 5. Post ledger entries: Credit advance
    // Debit CREDIT (increase exposure), Credit PAYABLE (funds available for payout)
    const ledgerTx = await this.ledgerService.postTransaction({
      referenceId,
      referenceType: 'credit',
      type: 'CREDIT_ADVANCE',
      description: `Credit advance: ${effectiveAmount.toFixed(4)} ${currency}`,
      entries: [
        {
          accountId: creditAccount.id,
          amount: effectiveAmount.toFixed(4), // Debit CREDIT (exposure increases)
          currency,
          description: 'Credit advance issued',
        },
        {
          accountId: payableAccount.id,
          amount: Money.negate(effectiveAmount.toString()).toFixed(4), // Credit PAYABLE (available for withdrawal)
          currency,
          description: 'Credit advance to payable',
        },
      ],
    });

    // 6. Record credit usage
    const usage = await this.prisma.creditUsage.create({
      data: {
        creditLineId: creditLine.id,
        type: 'ADVANCE',
        amount: effectiveAmount.toFixed(4),
        referenceId,
        description: `Advance against ${referenceId}`,
      },
    });

    // 7. Update credit line usage
    const updatedCreditLine = await this.prisma.creditLine.update({
      where: { id: creditLine.id },
      data: {
        usedAmount: Money.add(
          creditLine.usedAmount.toString(),
          effectiveAmount.toString(),
        ).toFixed(4),
      },
    });

    this.eventEmitter.emit(AgncyPayEvent.CREDIT_APPLIED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'CreditEngine',
      creditLineId: creditLine.id,
      walletId,
      amount: effectiveAmount.toFixed(4),
      usedAmount: updatedCreditLine.usedAmount.toString(),
      maxAmount: updatedCreditLine.maxAmount.toString(),
    });

    this.logger.log(
      `Credit advance: ${effectiveAmount.toFixed(4)} ${currency} for wallet ${walletId} ` +
        `(used: ${updatedCreditLine.usedAmount}/${updatedCreditLine.maxAmount})`,
    );

    return {
      creditLine: updatedCreditLine,
      usage,
      ledgerTransactionId: ledgerTx.id,
    };
  }

  /**
   * Auto-reconcile credit when actual payment arrives.
   * Reduces credit exposure by repaying the advance.
   */
  async reconcileCredit(
    walletId: string,
    paymentAmount: string,
    paymentId: string,
    currency: string = 'USD',
  ): Promise<CreditUsage | null> {
    const creditLine = await this.prisma.creditLine.findUnique({
      where: {
        walletId_currency: {
          walletId,
          currency,
        },
      },
    });

    if (!creditLine || Money.isZero(creditLine.usedAmount.toString())) {
      return null; // No credit to reconcile
    }

    // Repay the lesser of: payment amount or outstanding credit
    const repaymentAmount = Money.min(
      paymentAmount,
      creditLine.usedAmount.toString(),
    );

    if (Money.isZero(repaymentAmount.toString())) {
      return null;
    }

    // Get accounts
    const creditAccount = await this.ledgerService.getAccountByType(
      walletId,
      'CREDIT',
      currency,
    );
    const payableAccount = await this.ledgerService.getAccountByType(
      walletId,
      'PAYABLE',
      currency,
    );

    if (!creditAccount || !payableAccount) {
      return null;
    }

    // Post repayment: reverse the credit advance entries
    await this.ledgerService.postTransaction({
      referenceId: paymentId,
      referenceType: 'credit',
      type: 'CREDIT_REPAYMENT',
      description: `Credit repayment from payment ${paymentId}`,
      entries: [
        {
          accountId: creditAccount.id,
          amount: Money.negate(repaymentAmount.toString()).toFixed(4), // Credit CREDIT (reduce exposure)
          currency,
          description: 'Credit repaid from settled payment',
        },
        {
          accountId: payableAccount.id,
          amount: repaymentAmount.toFixed(4), // Debit PAYABLE (reduce owed amount since credit covered it)
          currency,
          description: 'Credit repayment offset',
        },
      ],
    });

    // Record usage
    const usage = await this.prisma.creditUsage.create({
      data: {
        creditLineId: creditLine.id,
        type: 'REPAYMENT',
        amount: repaymentAmount.toFixed(4),
        referenceId: paymentId,
        description: `Auto-repayment from payment ${paymentId}`,
      },
    });

    // Update credit line
    await this.prisma.creditLine.update({
      where: { id: creditLine.id },
      data: {
        usedAmount: Money.subtract(
          creditLine.usedAmount.toString(),
          repaymentAmount.toString(),
        ).toFixed(4),
      },
    });

    this.eventEmitter.emit(AgncyPayEvent.CREDIT_REPAID, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'CreditEngine',
      creditLineId: creditLine.id,
      walletId,
      amount: repaymentAmount.toFixed(4),
    });

    this.logger.log(
      `Credit reconciled: ${repaymentAmount.toFixed(4)} ${currency} repaid for wallet ${walletId}`,
    );

    return usage;
  }

  /**
   * Freeze a credit line (e.g., due to high risk or non-payment).
   */
  async freezeCreditLine(
    walletId: string,
    reason: string,
    currency: string = 'USD',
  ): Promise<CreditLine> {
    const creditLine = await this.prisma.creditLine.findUnique({
      where: {
        walletId_currency: { walletId, currency },
      },
    });

    if (!creditLine) {
      throw new NotFoundException(
        `No credit line found for wallet ${walletId}`,
      );
    }

    const frozen = await this.prisma.creditLine.update({
      where: { id: creditLine.id },
      data: {
        status: 'FROZEN',
        metadata: { frozenReason: reason, frozenAt: new Date().toISOString() },
      },
    });

    this.eventEmitter.emit(AgncyPayEvent.CREDIT_LINE_FROZEN, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'CreditEngine',
      creditLineId: creditLine.id,
      walletId,
      reason,
    });

    return frozen;
  }

  /**
   * Get credit line details for a wallet.
   */
  async getCreditLine(
    walletId: string,
    currency: string = 'USD',
  ): Promise<CreditLine | null> {
    return this.prisma.creditLine.findUnique({
      where: {
        walletId_currency: { walletId, currency },
      },
      include: { usages: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
  }
}
