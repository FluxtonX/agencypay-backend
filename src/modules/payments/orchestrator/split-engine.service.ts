import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { LedgerService, type DbClient } from '../../ledger/ledger.service.js';
import { Money } from '../../../common/utils/money.util.js';
import type { SplitInvoiceDto, SplitResult } from '../dto/split.dto.js';
import type { LedgerEntryDto } from '../../ledger/dto/ledger.dto.js';
import { Decimal } from 'decimal.js';

/**
 * SplitEngine — Computes balanced ledger entries for multi-party payment splits.
 *
 * Given an invoice with participants and split ratios, produces ledger entries
 * where SUM(amount) = 0, respecting proportional splits and platform fees.
 *
 * Handles:
 * - Full payments
 * - Partial payments (proportional scaling)
 * - Platform fee extraction
 * - Remainder distribution (avoids rounding loss)
 */
@Injectable()
export class SplitEngine {
  private readonly logger = new Logger(SplitEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  /**
   * Compute split entries for an invoice payment.
   *
   * For a $1000 invoice split 70/30 between wallet A and B:
   * - Payer's CASH account: +1000 (debit — money comes in)
   * - Wallet A PAYABLE: -700 (credit — platform owes A $700)
   * - Wallet B PAYABLE: -300 (credit — platform owes B $300)
   *
   * With a 2.5% platform fee:
   * - Payer's CASH: +1000
   * - Platform FEE: -25  (credit to platform fee account)
   * - Wallet A PAYABLE: -682.50
   * - Wallet B PAYABLE: -292.50
   *
   * @param tx  Optional Prisma transaction client for atomic cross-service ops.
   */
  async computeSplitEntries(
    dto: SplitInvoiceDto,
    actualPaymentAmount?: string,
    tx?: DbClient,
  ): Promise<LedgerEntryDto[]> {
    // 1. Validate ratios sum to 1
    const ratios = dto.participants.map((p) => new Decimal(p.ratio));
    const ratioSum = ratios.reduce((a, b) => a.plus(b), Money.ZERO);

    // Account for platform fee ratio
    const platformFeeRatio = dto.platformFeeRatio
      ? new Decimal(dto.platformFeeRatio)
      : Money.ZERO;
    const totalRatio = ratioSum.plus(platformFeeRatio);

    if (!totalRatio.equals(new Decimal(1))) {
      throw new BadRequestException(
        `Split ratios must sum to 1.0 (including platform fee). Got: ${totalRatio.toString()}`,
      );
    }

    // 2. Determine effective payment amount (for partial payments)
    const invoiceAmount = new Decimal(dto.totalAmount);
    const paymentAmount = actualPaymentAmount
      ? new Decimal(actualPaymentAmount)
      : invoiceAmount;

    if (Money.greaterThan(paymentAmount, invoiceAmount)) {
      throw new BadRequestException(
        `Payment amount (${paymentAmount}) exceeds invoice amount (${invoiceAmount})`,
      );
    }

    // 3. Get payer's CASH account
    const payerCashAccount = await this.ledgerService.getAccountByType(
      dto.payerWalletId,
      'CASH',
      dto.currency,
      tx,
    );

    if (!payerCashAccount) {
      throw new BadRequestException(
        `Payer wallet ${dto.payerWalletId} has no CASH account in ${dto.currency}`,
      );
    }

    const entries: LedgerEntryDto[] = [];

    // 4. Debit the payer's CASH account (money comes in)
    entries.push({
      accountId: payerCashAccount.id,
      amount: paymentAmount.toFixed(4),
      currency: dto.currency,
      description: `Payment received for invoice ${dto.invoiceId}`,
    });

    // 5. Compute platform fee
    let remainingAmount = paymentAmount;

    if (
      !platformFeeRatio.isZero() &&
      dto.platformWalletId
    ) {
      const feeAmount = Money.multiply(paymentAmount, platformFeeRatio)
        .toDecimalPlaces(4, Decimal.ROUND_DOWN);

      const platformFeeAccount = await this.ledgerService.getAccountByType(
        dto.platformWalletId,
        'FEE',
        dto.currency,
        tx,
      );

      if (!platformFeeAccount) {
        throw new BadRequestException(
          `Platform wallet ${dto.platformWalletId} has no FEE account`,
        );
      }

      entries.push({
        accountId: platformFeeAccount.id,
        amount: Money.negate(feeAmount).toFixed(4),
        currency: dto.currency,
        description: `Platform fee for invoice ${dto.invoiceId}`,
      });

      remainingAmount = Money.subtract(paymentAmount, feeAmount);
    }

    // 6. Distribute remaining amount among participants proportionally
    const participantRatios = dto.participants.map((p) => p.ratio);
    const distributedAmounts = Money.distribute(
      remainingAmount.toString(),
      participantRatios,
    );

    for (let i = 0; i < dto.participants.length; i++) {
      const participant = dto.participants[i];
      const amount = distributedAmounts[i];

      const payableAccount = await this.ledgerService.getAccountByType(
        participant.walletId,
        'PAYABLE',
        dto.currency,
        tx,
      );

      if (!payableAccount) {
        throw new BadRequestException(
          `Participant wallet ${participant.walletId} has no PAYABLE account`,
        );
      }

      entries.push({
        accountId: payableAccount.id,
        amount: Money.negate(amount).toFixed(4),
        currency: dto.currency,
        description:
          participant.description ||
          `Split payment for invoice ${dto.invoiceId} (ratio: ${participant.ratio})`,
      });
    }

    // 7. Final validation — sum must be zero
    this.ledgerService.validateDoubleEntryInvariant(entries);

    this.logger.log(
      `Split computed for invoice ${dto.invoiceId}: ${entries.length} entries, ` +
        `payment: ${paymentAmount.toFixed(4)} ${dto.currency}`,
    );

    return entries;
  }

  /**
   * Scale split entries for a partial payment.
   * Given original split ratios and a partial amount, produces proportional entries.
   */
  async computePartialSplitEntries(
    dto: SplitInvoiceDto,
    partialAmount: string,
    tx?: DbClient,
  ): Promise<LedgerEntryDto[]> {
    return this.computeSplitEntries(dto, partialAmount, tx);
  }
}
