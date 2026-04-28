import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { SplitEngine } from './orchestrator/split-engine.service.js';
import { Money } from '../../common/utils/money.util.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import type { IngestPaymentDto, RefundPaymentDto, ChargebackPaymentDto } from './dto/payment.dto.js';
import type { SplitInvoiceDto } from './dto/split.dto.js';
import { v4 as uuidv4 } from 'uuid';
import type { Payment, PaymentSplit } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly splitEngine: SplitEngine,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Ingest a payment (e.g., from QuickBooks webhook or API).
   * Creates the Payment record and posts the corresponding ledger transaction.
   */
  async ingestPayment(
    dto: IngestPaymentDto,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // 1. Deduplicate by source + externalId
    if (dto.externalId) {
      const existing = await this.prisma.payment.findUnique({
        where: {
          source_externalId: {
            source: dto.source,
            externalId: dto.externalId,
          },
        },
      });

      if (existing) {
        this.logger.warn(
          `Duplicate payment ignored: ${dto.source}:${dto.externalId}`,
        );
        return existing;
      }
    }

    // 2. Validate wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: dto.walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${dto.walletId} not found`);
    }

    if (wallet.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Wallet ${dto.walletId} is ${wallet.status}`,
      );
    }

    const currency = dto.currency || 'USD';

    // 3. Create the Payment record
    const payment = await this.prisma.payment.create({
      data: {
        walletId: dto.walletId,
        externalId: dto.externalId,
        source: dto.source,
        amount: dto.amount,
        currency,
        status: 'PROCESSING',
        invoiceId: dto.invoiceId,
        invoiceData: (dto.invoiceData ?? undefined) as any,
        splitConfig: (dto.splitConfig ?? undefined) as any,
        description: dto.description,
        metadata: (dto.metadata ?? undefined) as any,
      },
    });

    try {
      // 4. If split config is provided, compute split entries
      if (dto.splitConfig && dto.splitConfig.participants.length > 0) {
        const splitDto: SplitInvoiceDto = {
          invoiceId: dto.invoiceId || payment.id,
          totalAmount: dto.amount,
          currency,
          payerWalletId: dto.walletId,
          participants: dto.splitConfig.participants.map((p) => ({
            walletId: p.walletId,
            ratio: p.ratio,
            description: p.description,
          })),
          platformFeeRatio: dto.splitConfig.platformFeeRatio,
          platformWalletId: dto.splitConfig.platformWalletId,
        };

        const entries = await this.splitEngine.computeSplitEntries(splitDto);

        // Post to ledger
        await this.ledgerService.postTransaction({
          referenceId: payment.id,
          referenceType: 'payment',
          type: 'PAYMENT_SPLIT',
          description: `Split payment for invoice ${dto.invoiceId || payment.id}`,
          entries,
        });

        // Record splits
        for (let i = 0; i < dto.splitConfig.participants.length; i++) {
          const participant = dto.splitConfig.participants[i];
          const payableAccount = await this.ledgerService.getAccountByType(
            participant.walletId,
            'PAYABLE',
            currency,
          );

          if (payableAccount) {
            await this.prisma.paymentSplit.create({
              data: {
                paymentId: payment.id,
                accountId: payableAccount.id,
                walletId: participant.walletId,
                ratio: participant.ratio,
                amount: entries[i + 1] // +1 to skip the payer's debit entry
                  ? Money.abs(entries[i + 1].amount).toString()
                  : '0',
                currency,
              },
            });
          }
        }
      } else {
        // Simple payment — credit directly to wallet's PAYABLE account
        const cashAccount = await this.ledgerService.getAccountByType(
          dto.walletId,
          'CASH',
          currency,
        );
        const payableAccount = await this.ledgerService.getAccountByType(
          dto.walletId,
          'PAYABLE',
          currency,
        );

        if (!cashAccount || !payableAccount) {
          throw new BadRequestException(
            `Wallet ${dto.walletId} missing required accounts`,
          );
        }

        await this.ledgerService.postTransaction({
          referenceId: payment.id,
          referenceType: 'payment',
          type: 'PAYMENT_RECEIVED',
          description: `Payment received: ${dto.amount} ${currency}`,
          entries: [
            {
              accountId: cashAccount.id,
              amount: dto.amount,
              currency,
              description: 'Incoming payment',
            },
            {
              accountId: payableAccount.id,
              amount: Money.negate(dto.amount).toFixed(4),
              currency,
              description: 'Amount owed to wallet',
            },
          ],
        });
      }

      // 5. Mark as settled
      const settledPayment = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SETTLED',
          settledAmount: dto.amount,
          settledAt: new Date(),
        },
      });

      this.eventEmitter.emit(AgncyPayEvent.PAYMENT_SETTLED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PaymentsService',
        paymentId: payment.id,
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        status: 'SETTLED',
      });

      this.logger.log(
        `Payment ingested and settled: ${payment.id} — ${dto.amount} ${currency}`,
      );

      return settledPayment;
    } catch (error) {
      // Roll back payment status on failure
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });

      this.eventEmitter.emit(AgncyPayEvent.PAYMENT_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PaymentsService',
        paymentId: payment.id,
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        status: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Process a refund for a payment.
   * Creates reversal ledger entries.
   */
  async refundPayment(dto: RefundPaymentDto): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: dto.paymentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment ${dto.paymentId} not found`);
    }

    if (payment.status !== 'SETTLED') {
      throw new BadRequestException(
        `Cannot refund payment in status: ${payment.status}`,
      );
    }

    const refundAmount = dto.amount || payment.amount.toString();

    if (
      Money.greaterThan(
        refundAmount,
        payment.settledAmount?.toString() || payment.amount.toString(),
      )
    ) {
      throw new BadRequestException('Refund amount exceeds settled amount');
    }

    // Find the original ledger transaction
    const transactions = await this.ledgerService.getTransactionsByReference(
      payment.id,
      'payment',
    );

    const postedTx = transactions.find((t) => t.status === 'POSTED');
    if (!postedTx) {
      throw new BadRequestException(
        'No posted ledger transaction found for this payment',
      );
    }

    // Reverse the transaction
    await this.ledgerService.reverseTransaction(
      postedTx.id,
      dto.reason,
      'REFUND',
    );

    const refundedPayment = await this.prisma.payment.update({
      where: { id: dto.paymentId },
      data: { status: 'REFUNDED' },
    });

    this.eventEmitter.emit(AgncyPayEvent.PAYMENT_REFUNDED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'PaymentsService',
      paymentId: dto.paymentId,
      walletId: payment.walletId,
      amount: refundAmount,
      currency: payment.currency,
      status: 'REFUNDED',
    });

    return refundedPayment;
  }

  /**
   * Handle a chargeback.
   * Similar to refund but may result in negative balances for risk recovery.
   */
  async handleChargeback(dto: ChargebackPaymentDto): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: dto.paymentId },
    });

    if (!payment) {
      throw new NotFoundException(`Payment ${dto.paymentId} not found`);
    }

    // Chargebacks can happen on settled or even already-paid-out payments
    const transactions = await this.ledgerService.getTransactionsByReference(
      payment.id,
      'payment',
    );

    const postedTx = transactions.find((t) => t.status === 'POSTED');
    if (postedTx) {
      await this.ledgerService.reverseTransaction(
        postedTx.id,
        `Chargeback: ${dto.reason}`,
        'CHARGEBACK',
      );
    }

    const chargebackPayment = await this.prisma.payment.update({
      where: { id: dto.paymentId },
      data: { status: 'CHARGEBACKED' },
    });

    this.eventEmitter.emit(AgncyPayEvent.PAYMENT_CHARGEBACKED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'PaymentsService',
      paymentId: dto.paymentId,
      walletId: payment.walletId,
      amount: dto.amount || payment.amount.toString(),
      currency: payment.currency,
      status: 'CHARGEBACKED',
    });

    this.logger.warn(
      `Chargeback processed for payment ${dto.paymentId}: ${dto.reason}`,
    );

    return chargebackPayment;
  }

  /**
   * Get payment by ID.
   */
  async getPayment(paymentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { splits: true },
    });
  }

  /**
   * List payments by wallet.
   */
  async listPaymentsByWallet(
    walletId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { walletId },
      include: { splits: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
