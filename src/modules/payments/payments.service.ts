import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService, type DbClient } from '../ledger/ledger.service.js';
import { SplitEngine } from './orchestrator/split-engine.service.js';
import { IdempotencyService } from '../../common/utils/idempotency.service.js';
import { Money } from '../../common/utils/money.util.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import type { IngestPaymentDto, RefundPaymentDto, ChargebackPaymentDto } from './dto/payment.dto.js';
import type { SplitInvoiceDto } from './dto/split.dto.js';
import { v4 as uuidv4 } from 'uuid';
import type { Payment, PaymentSplit } from '@prisma/client';
import { Decimal } from 'decimal.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly splitEngine: SplitEngine,
    private readonly idempotencyService: IdempotencyService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Ingest a payment (e.g., from QuickBooks webhook or API).
   *
   * ATOMICITY GUARANTEE:
   * Payment record, ledger transaction, and payment splits are ALL created
   * within a single Prisma interactive transaction. If ANY step fails,
   * the entire operation is rolled back — no orphaned records.
   */
  async ingestPayment(
    dto: IngestPaymentDto,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // 1. Idempotency check — prevents duplicate processing for API-originated payments
    if (idempotencyKey) {
      const idempotencyResult = await this.idempotencyService.check<Payment>(
        idempotencyKey,
        'POST',
        '/payments',
      );

      if (!idempotencyResult.isNew && idempotencyResult.response) {
        return idempotencyResult.response;
      }
    }

    // 2. Deduplicate by source + externalId (outside transaction — read-only)
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

    // 3. Validate wallet (outside transaction — read-only)
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: dto.walletId },
    });

    if (!wallet) {
      if (idempotencyKey) await this.idempotencyService.remove(idempotencyKey);
      throw new NotFoundException(`Wallet ${dto.walletId} not found`);
    }

    if (wallet.status !== 'ACTIVE') {
      if (idempotencyKey) await this.idempotencyService.remove(idempotencyKey);
      throw new BadRequestException(
        `Wallet ${dto.walletId} is ${wallet.status}`,
      );
    }

    const currency = dto.currency || 'USD';

    // 4. ATOMIC: Payment + Ledger + Splits in a single transaction
    try {
      const settledPayment = await this.prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as DbClient;

        // 3a. Create the Payment record
        const payment = await tx.payment.create({
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

        // 3b. Post ledger entries (split or simple)
        if (dto.splitConfig && dto.splitConfig.participants.length > 0) {
          await this._ingestWithSplits(payment, dto, currency, txClient);
        } else {
          await this._ingestSimple(payment, dto, currency, txClient);
        }

        // 3c. Mark as settled (within same transaction)
        const settled = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'SETTLED',
            settledAmount: dto.amount,
            settledAt: new Date(),
          },
        });

        return settled;
      });

      // 5. Record idempotency AFTER successful commit
      if (idempotencyKey) {
        await this.idempotencyService.complete(idempotencyKey, 201, settledPayment);
      }

      // 6. Emit events AFTER successful commit
      this.eventEmitter.emit(AgncyPayEvent.PAYMENT_SETTLED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PaymentsService',
        paymentId: settledPayment.id,
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        status: 'SETTLED',
      });

      this.logger.log(
        `Payment ingested and settled: ${settledPayment.id} — ${dto.amount} ${currency}`,
      );

      return settledPayment;
    } catch (error) {
      // The transaction auto-rolls back on error — no orphaned records.
      if (idempotencyKey) await this.idempotencyService.remove(idempotencyKey);

      this.eventEmitter.emit(AgncyPayEvent.PAYMENT_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PaymentsService',
        paymentId: 'unknown', // Payment was rolled back, no ID available
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
   * Handle a split payment within an active transaction.
   */
  private async _ingestWithSplits(
    payment: Payment,
    dto: IngestPaymentDto,
    currency: string,
    tx: DbClient,
  ): Promise<void> {
    const splitDto: SplitInvoiceDto = {
      invoiceId: dto.invoiceId || payment.id,
      totalAmount: dto.amount,
      currency,
      payerWalletId: dto.walletId,
      participants: dto.splitConfig!.participants.map((p) => ({
        walletId: p.walletId,
        ratio: p.ratio,
        description: p.description,
      })),
      platformFeeRatio: dto.splitConfig!.platformFeeRatio,
      platformWalletId: dto.splitConfig!.platformWalletId,
    };

    // Compute ledger entries (tx-aware)
    const entries = await this.splitEngine.computeSplitEntries(splitDto, undefined, tx);

    // Post to ledger (tx-aware — no nested $transaction)
    await this.ledgerService.postTransaction(
      {
        referenceId: payment.id,
        referenceType: 'payment',
        type: 'PAYMENT_SPLIT',
        description: `Split payment for invoice ${dto.invoiceId || payment.id}`,
        entries,
      },
      tx,
    );

    // Build split records from participant config + computed entries
    // Entries layout: [0] = payer debit, [1..N] = participant credits (+ optional fee)
    // We match participants by their walletId → PAYABLE accountId to avoid index fragility.
    const participantEntryMap = new Map<string, string>();
    for (const entry of entries) {
      // We need to resolve which wallet this entry belongs to by looking up the account
      const account = await this.ledgerService.getAccountByType(
        dto.splitConfig!.participants.find(
          (p) => entries.some(async (e) => {
            const acc = await this.ledgerService.getAccountByType(p.walletId, 'PAYABLE', currency, tx);
            return acc?.id === e.accountId;
          }),
        )?.walletId || '',
        'PAYABLE',
        currency,
        tx,
      );
      if (account) {
        participantEntryMap.set(account.id, entry.amount);
      }
    }

    // Create PaymentSplit records atomically within the same transaction
    for (const participant of dto.splitConfig!.participants) {
      const payableAccount = await this.ledgerService.getAccountByType(
        participant.walletId,
        'PAYABLE',
        currency,
        tx,
      );

      if (payableAccount) {
        // Find the matching entry by accountId
        const matchedEntry = entries.find((e) => e.accountId === payableAccount.id);
        const splitAmount = matchedEntry
          ? Money.abs(matchedEntry.amount).toString()
          : '0';

        await (tx as any).paymentSplit.create({
          data: {
            paymentId: payment.id,
            accountId: payableAccount.id,
            walletId: participant.walletId,
            ratio: participant.ratio,
            amount: splitAmount,
            currency,
          },
        });
      }
    }
  }

  /**
   * Handle a simple (non-split) payment within an active transaction.
   */
  private async _ingestSimple(
    payment: Payment,
    dto: IngestPaymentDto,
    currency: string,
    tx: DbClient,
  ): Promise<void> {
    const cashAccount = await this.ledgerService.getAccountByType(
      dto.walletId,
      'CASH',
      currency,
      tx,
    );
    const payableAccount = await this.ledgerService.getAccountByType(
      dto.walletId,
      'PAYABLE',
      currency,
      tx,
    );

    if (!cashAccount || !payableAccount) {
      throw new BadRequestException(
        `Wallet ${dto.walletId} missing required accounts`,
      );
    }

    await this.ledgerService.postTransaction(
      {
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
      },
      tx,
    );
  }

  /**
   * Process a refund for a payment.
   * Creates reversal ledger entries. Original transaction stays POSTED (immutable).
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

    const postedTx = transactions.find((t) => t.status === 'POSTED' && !t.originalTransactionId);
    if (!postedTx) {
      throw new BadRequestException(
        'No posted ledger transaction found for this payment',
      );
    }

    // Reverse the transaction (creates a new linked transaction — original stays POSTED)
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

    const postedTx = transactions.find((t) => t.status === 'POSTED' && !t.originalTransactionId);
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
