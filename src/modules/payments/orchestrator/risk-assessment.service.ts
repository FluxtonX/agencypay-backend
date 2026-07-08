import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgncyPayEvent } from '../../../common/constants/events.js';
import { ConfigService } from '@nestjs/config';
import { Money } from '../../../common/utils/money.util.js';
import { v4 as uuidv4 } from 'uuid';
import type { RiskAssessment, RiskDecision } from '@prisma/client';
import { Decimal } from 'decimal.js';

interface RiskFactors {
  walletAge: { score: number; weight: number; detail: string };
  paymentHistory: { score: number; weight: number; detail: string };
  invoiceSize: { score: number; weight: number; detail: string };
  paymentReliability: { score: number; weight: number; detail: string };
  chargebackRate: { score: number; weight: number; detail: string };
  existingExposure: { score: number; weight: number; detail: string };
}

/**
 * RiskAssessmentService — Rule-based risk scoring for credit eligibility.
 *
 * Scores on a 0-100 scale across multiple factors.
 * No ML required — deterministic rules-based approach.
 */
@Injectable()
export class RiskAssessmentService {
  private readonly logger = new Logger(RiskAssessmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Perform a risk assessment for a wallet requesting credit.
   */
  async assessRisk(
    walletId: string,
    requestedAmount: string,
  ): Promise<RiskAssessment> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new Error(`Wallet ${walletId} not found`);
    }

    // Compute individual risk factors
    const factors = await this.computeRiskFactors(walletId, requestedAmount);

    // Compute weighted score
    const totalWeight = Object.values(factors).reduce(
      (sum, f) => sum + f.weight,
      0,
    );
    const weightedScore = Object.values(factors).reduce(
      (sum, f) => sum + f.score * f.weight,
      0,
    );
    const finalScore = Math.round(weightedScore / totalWeight);

    // Determine decision
    const minApproval = this.config.get<number>(
      'credit.minScoreForApproval',
      60,
    );
    const minPartial = this.config.get<number>(
      'credit.minScoreForPartial',
      40,
    );

    let decision: RiskDecision;
    let approvedAmount: string | undefined;

    if (finalScore >= minApproval) {
      decision = 'APPROVE';
      approvedAmount = requestedAmount;
    } else if (finalScore >= minPartial) {
      decision = 'PARTIAL';
      // Approve proportionally based on score
      const ratio = new Decimal(finalScore)
        .dividedBy(100)
        .toDecimalPlaces(4);
      approvedAmount = Money.multiply(requestedAmount, ratio.toString()).toFixed(4);
    } else {
      decision = 'REJECT';
      approvedAmount = '0';
    }

    // Persist the assessment
    const assessment = await this.prisma.riskAssessment.create({
      data: {
        walletId,
        score: finalScore,
        decision,
        factors: factors as any,
        requestedAmount,
        approvedAmount,
      },
    });

    this.eventEmitter.emit(AgncyPayEvent.RISK_ASSESSMENT_COMPLETED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'RiskAssessmentService',
      walletId,
      score: finalScore,
      decision,
      requestedAmount,
      approvedAmount,
    });

    this.logger.log(
      `Risk assessment for wallet ${walletId}: score=${finalScore}, decision=${decision}, ` +
        `approved=${approvedAmount}`,
    );

    return assessment;
  }

  /**
   * Compute individual risk factors.
   */
  private async computeRiskFactors(
    walletId: string,
    requestedAmount: string,
  ): Promise<RiskFactors> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    // --- Factor 1: Wallet Age ---
    const walletAgeMs = Date.now() - (wallet?.createdAt.getTime() || Date.now());
    const walletAgeDays = walletAgeMs / (1000 * 60 * 60 * 24);
    let walletAgeScore = 0;
    if (walletAgeDays > 365) walletAgeScore = 100;
    else if (walletAgeDays > 180) walletAgeScore = 80;
    else if (walletAgeDays > 90) walletAgeScore = 60;
    else if (walletAgeDays > 30) walletAgeScore = 40;
    else if (walletAgeDays > 7) walletAgeScore = 20;
    else walletAgeScore = 5;

    // --- Factor 2: Payment History (count of settled payments) ---
    const paymentCount = await this.prisma.payment.count({
      where: { walletId, status: 'SETTLED' },
    });
    let paymentHistoryScore = 0;
    if (paymentCount > 50) paymentHistoryScore = 100;
    else if (paymentCount > 20) paymentHistoryScore = 80;
    else if (paymentCount > 10) paymentHistoryScore = 60;
    else if (paymentCount > 5) paymentHistoryScore = 40;
    else if (paymentCount > 0) paymentHistoryScore = 20;
    else paymentHistoryScore = 0;

    // --- Factor 3: Invoice Size relative to history ---
    const payments = await this.prisma.payment.findMany({
      where: { walletId, status: 'SETTLED' },
      select: { amount: true },
    });
    const avgPayment =
      payments.length > 0
        ? payments.reduce(
            (sum, p) => sum.plus(new Decimal(p.amount.toString())),
            Money.ZERO,
          ).dividedBy(payments.length)
        : Money.ZERO;

    let invoiceSizeScore = 50; // Default for first-time
    if (!avgPayment.isZero()) {
      const ratio = new Decimal(requestedAmount).dividedBy(avgPayment);
      if (ratio.lessThan(1)) invoiceSizeScore = 90;
      else if (ratio.lessThan(2)) invoiceSizeScore = 70;
      else if (ratio.lessThan(5)) invoiceSizeScore = 40;
      else invoiceSizeScore = 15;
    }

    // --- Factor 4: Payment Reliability (on-time rate) ---
    const totalPayments = await this.prisma.payment.count({
      where: { walletId },
    });
    const failedPayments = await this.prisma.payment.count({
      where: {
        walletId,
        status: { in: ['FAILED', 'CHARGEBACKED'] },
      },
    });
    const reliabilityRate =
      totalPayments > 0
        ? ((totalPayments - failedPayments) / totalPayments) * 100
        : 50;
    const paymentReliabilityScore = Math.round(reliabilityRate);

    // --- Factor 5: Chargeback Rate ---
    const chargebacks = await this.prisma.payment.count({
      where: { walletId, status: 'CHARGEBACKED' },
    });
    let chargebackScore = 100;
    if (totalPayments > 0) {
      const cbRate = (chargebacks / totalPayments) * 100;
      if (cbRate > 5) chargebackScore = 0;
      else if (cbRate > 2) chargebackScore = 30;
      else if (cbRate > 1) chargebackScore = 60;
      else if (cbRate > 0) chargebackScore = 80;
      else chargebackScore = 100;
    }

    // --- Factor 6: Existing Credit Exposure ---
    const existingCredit = await this.prisma.creditLine.findFirst({
      where: { walletId },
    });
    let exposureScore = 80; // No credit history = mild positive
    if (existingCredit) {
      const utilization = existingCredit.maxAmount.toString() !== '0'
        ? new Decimal(existingCredit.usedAmount.toString())
            .dividedBy(new Decimal(existingCredit.maxAmount.toString()))
            .toNumber()
        : 0;
      if (utilization > 0.9) exposureScore = 10;
      else if (utilization > 0.7) exposureScore = 30;
      else if (utilization > 0.5) exposureScore = 50;
      else if (utilization > 0.3) exposureScore = 70;
      else exposureScore = 90;
    }

    return {
      walletAge: {
        score: walletAgeScore,
        weight: 15,
        detail: `Wallet age: ${Math.round(walletAgeDays)} days`,
      },
      paymentHistory: {
        score: paymentHistoryScore,
        weight: 25,
        detail: `${paymentCount} settled payments`,
      },
      invoiceSize: {
        score: invoiceSizeScore,
        weight: 20,
        detail: `Requested: ${requestedAmount}, Avg payment: ${avgPayment.toFixed(2)}`,
      },
      paymentReliability: {
        score: paymentReliabilityScore,
        weight: 20,
        detail: `Reliability: ${reliabilityRate.toFixed(1)}%`,
      },
      chargebackRate: {
        score: chargebackScore,
        weight: 15,
        detail: `${chargebacks} chargebacks out of ${totalPayments} payments`,
      },
      existingExposure: {
        score: exposureScore,
        weight: 5,
        detail: existingCredit
          ? `Credit utilization: ${new Decimal(existingCredit.usedAmount.toString()).dividedBy(new Decimal(existingCredit.maxAmount.toString() || '1')).times(100).toFixed(1)}%`
          : 'No existing credit',
      },
    };
  }

  /**
   * Get the latest risk assessment for a wallet.
   */
  async getLatestAssessment(walletId: string): Promise<RiskAssessment | null> {
    return this.prisma.riskAssessment.findFirst({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
