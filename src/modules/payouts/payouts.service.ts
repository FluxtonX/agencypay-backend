import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService, type DbClient } from '../ledger/ledger.service.js';
import { ColumnBankAdapter } from '../../integrations/column/column.service.js';
import { IdempotencyService } from '../../common/utils/idempotency.service.js';
import { Money } from '../../common/utils/money.util.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import type { InitiatePayoutDto, PayoutWebhookDto } from './dto/payout.dto.js';
import { v4 as uuidv4 } from 'uuid';
import type { Payout } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly columnAdapter: ColumnBankAdapter,
    private readonly idempotencyService: IdempotencyService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initiate a payout (withdrawal) from a wallet.
   *
   * DOUBLE-SPEND PREVENTION:
   * Balance check uses SELECT FOR UPDATE to acquire a row-level lock on the
   * PAYABLE account. Any concurrent payout attempting the same account will
   * BLOCK until this transaction commits or rolls back.
   *
   * Flow:
   * 1. Idempotency check
   * 2. ATOMIC TRANSACTION:
   *    a. Lock PAYABLE account (SELECT FOR UPDATE)
   *    b. Verify sufficient balance
   *    c. Create Payout record
   *    d. Post ledger entries: debit PAYABLE, credit SUSPENSE
   * 3. Submit to bank (Column API) — outside DB transaction
   * 4. Update payout with bank reference
   */
  async initiatePayout(
    dto: InitiatePayoutDto,
    idempotencyKey: string,
  ): Promise<Payout> {
    // Idempotency check
    const idempotencyResult = await this.idempotencyService.check<Payout>(
      idempotencyKey,
      'POST',
      '/payouts',
    );

    if (!idempotencyResult.isNew && idempotencyResult.response) {
      return idempotencyResult.response;
    }

    const currency = dto.currency || 'USD';
    const amount = new Decimal(dto.amount);

    // ATOMIC: Lock + balance check + payout creation + ledger posting
    let payout: Payout;
    try {
      payout = await this.prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as DbClient;

        // 1. Get PAYABLE account
        const payableAccount = await this.ledgerService.getAccountByType(
          dto.walletId,
          'PAYABLE',
          currency,
          txClient,
        );

        if (!payableAccount) {
          throw new BadRequestException(
            `Wallet ${dto.walletId} has no PAYABLE account`,
          );
        }

        // 2. LOCK the account row — prevents concurrent payouts from reading stale balance
        await this.ledgerService.lockAccountForUpdate(payableAccount.id, txClient);

        // 3. Compute balance AFTER acquiring lock (guaranteed to be current)
        const balance = await this.ledgerService.computeBalanceFromLedger(
          payableAccount.id,
          undefined,
          txClient,
        );

        // PAYABLE balance is negative (credit side) — the absolute value is available
        const availableBalance = balance.abs();

        if (Money.greaterThan(amount, availableBalance)) {
          throw new BadRequestException(
            `Insufficient balance. Available: ${availableBalance.toFixed(4)}, Requested: ${amount.toFixed(4)}`,
          );
        }

        // 4. Get/create SUSPENSE account
        let suspenseAccount = await this.ledgerService.getAccountByType(
          dto.walletId,
          'SUSPENSE',
          currency,
          txClient,
        );

        if (!suspenseAccount) {
          suspenseAccount = await (tx as any).account.create({
            data: {
              walletId: dto.walletId,
              type: 'SUSPENSE',
              currency,
            },
          });
        }

        // 5. Create Payout record
        const newPayout = await tx.payout.create({
          data: {
            walletId: dto.walletId,
            amount: dto.amount,
            currency,
            status: 'PROCESSING',
            bankAccountInfo: (dto.bankAccountInfo ?? undefined) as any,
            metadata: (dto.metadata ?? undefined) as any,
          },
        });

        // 6. Post ledger: reduce PAYABLE, move to SUSPENSE (within same tx)
        await this.ledgerService.postTransaction(
          {
            referenceId: newPayout.id,
            referenceType: 'payout',
            type: 'PAYOUT_INITIATED',
            description: `Payout initiated: ${dto.amount} ${currency}`,
            entries: [
              {
                accountId: payableAccount.id,
                amount: dto.amount, // Debit PAYABLE (reduce what's owed)
                currency,
                description: 'Payout from payable balance',
              },
              {
                accountId: suspenseAccount!.id,
                amount: Money.negate(dto.amount).toFixed(4), // Credit SUSPENSE (hold)
                currency,
                description: 'Payout held in suspense',
              },
            ],
          },
          txClient,
        );

        return newPayout;
      }); // Transaction commits here — lock is released
    } catch (error) {
      await this.idempotencyService.remove(idempotencyKey);

      this.eventEmitter.emit(AgncyPayEvent.PAYOUT_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PayoutsService',
        payoutId: 'unknown',
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }

    // 7. Submit to bank (OUTSIDE db transaction — external side effect)
    try {
      const bankResult = await this.columnAdapter.initiateACHTransfer({
        payoutId: payout.id,
        amount: dto.amount,
        currency,
        bankAccountInfo: dto.bankAccountInfo || {},
      });

      // CHECK bank response status (P0 fix — previously ignored 'failed' status)
      if (bankResult.status === 'failed') {
        // Bank rejected — reverse the ledger entries
        await this._handleBankRejection(payout, currency);

        await this.idempotencyService.remove(idempotencyKey);

        throw new BadRequestException(
          `Bank rejected payout ${payout.id}. The ledger has been reversed.`,
        );
      }

      // 8. Update payout with bank reference
      const submittedPayout = await this.prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: 'SUBMITTED',
          bankReference: bankResult.transferId,
          submittedAt: new Date(),
        },
      });

      // Record idempotency
      await this.idempotencyService.complete(idempotencyKey, 201, submittedPayout);

      this.eventEmitter.emit(AgncyPayEvent.PAYOUT_SUBMITTED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PayoutsService',
        payoutId: payout.id,
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        bankReference: bankResult.transferId,
      });

      this.logger.log(
        `Payout submitted: ${payout.id} — ${dto.amount} ${currency} — Bank ref: ${bankResult.transferId}`,
      );

      return submittedPayout;
    } catch (error) {
      // If it's our own BadRequestException from bank rejection, re-throw
      if (error instanceof BadRequestException) {
        throw error;
      }

      // Bank API failure (network error, timeout, etc.) — reverse ledger
      await this._handleBankRejection(payout, currency);

      await this.prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: 'FAILED',
          failureReason: error instanceof Error ? error.message : String(error),
        },
      });

      await this.idempotencyService.remove(idempotencyKey);

      this.eventEmitter.emit(AgncyPayEvent.PAYOUT_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PayoutsService',
        payoutId: payout.id,
        walletId: dto.walletId,
        amount: dto.amount,
        currency,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Reverse the PAYABLE→SUSPENSE ledger entries when bank rejects or fails.
   * Moves funds back from SUSPENSE to PAYABLE.
   */
  private async _handleBankRejection(
    payout: Payout,
    currency: string,
  ): Promise<void> {
    const transactions = await this.ledgerService.getTransactionsByReference(
      payout.id,
      'payout',
    );

    const initiationTx = transactions.find(
      (t) => t.status === 'POSTED' && t.type === 'PAYOUT_INITIATED',
    );

    if (initiationTx) {
      await this.ledgerService.reverseTransaction(
        initiationTx.id,
        'Bank rejected or failed — returning funds to PAYABLE',
        'ADJUSTMENT',
      );
    }

    await this.prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        failureReason: 'Bank rejected transfer',
      },
    });

    this.logger.warn(
      `Payout ${payout.id} reversed after bank rejection`,
    );
  }

  /**
   * Handle bank webhook confirming payout settlement or failure.
   * Moves funds from SUSPENSE to final state.
   */
  async handleBankWebhook(dto: PayoutWebhookDto): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({
      where: { id: dto.payoutId },
    });

    if (!payout) {
      throw new NotFoundException(`Payout ${dto.payoutId} not found`);
    }

    if (payout.status !== 'SUBMITTED') {
      this.logger.warn(
        `Bank webhook for payout ${dto.payoutId} in unexpected status: ${payout.status}`,
      );
      return payout;
    }

    const currency = payout.currency;

    const suspenseAccount = await this.ledgerService.getAccountByType(
      payout.walletId,
      'SUSPENSE',
      currency,
    );

    const cashAccount = await this.ledgerService.getAccountByType(
      payout.walletId,
      'CASH',
      currency,
    );

    if (!suspenseAccount || !cashAccount) {
      throw new BadRequestException('Missing required accounts for settlement');
    }

    if (dto.status === 'SETTLED') {
      // Move from SUSPENSE to CASH (money left the platform)
      await this.ledgerService.postTransaction({
        referenceId: payout.id,
        referenceType: 'payout',
        type: 'PAYOUT_SETTLED',
        description: 'Bank confirmed payout settlement',
        entries: [
          {
            accountId: suspenseAccount.id,
            amount: payout.amount.toString(), // Debit SUSPENSE (release hold)
            currency,
            description: 'Release suspense hold',
          },
          {
            accountId: cashAccount.id,
            amount: Money.negate(payout.amount.toString()).toFixed(4), // Credit CASH (money sent out)
            currency,
            description: 'Payout settled via bank',
          },
        ],
      });

      const settled = await this.prisma.payout.update({
        where: { id: dto.payoutId },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
        },
      });

      this.eventEmitter.emit(AgncyPayEvent.PAYOUT_COMPLETED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'PayoutsService',
        payoutId: dto.payoutId,
        walletId: payout.walletId,
        amount: payout.amount.toString(),
        currency,
        bankReference: dto.bankReference,
      });

      return settled;
    } else if (dto.status === 'FAILED' || dto.status === 'RETURNED') {
      // Reverse the suspense hold — return funds to PAYABLE
      const payableAccount = await this.ledgerService.getAccountByType(
        payout.walletId,
        'PAYABLE',
        currency,
      );

      if (!payableAccount) {
        throw new BadRequestException('Missing PAYABLE account for reversal');
      }

      await this.ledgerService.postTransaction({
        referenceId: payout.id,
        referenceType: 'payout',
        type: 'ADJUSTMENT',
        description: `Bank payout ${dto.status.toLowerCase()}: ${dto.failureReason || 'unknown'}`,
        entries: [
          {
            accountId: suspenseAccount.id,
            amount: payout.amount.toString(), // Debit SUSPENSE (release)
            currency,
            description: 'Release failed payout hold',
          },
          {
            accountId: payableAccount.id,
            amount: Money.negate(payout.amount.toString()).toFixed(4), // Credit PAYABLE (return)
            currency,
            description: 'Return funds after bank failure',
          },
        ],
      });

      const failed = await this.prisma.payout.update({
        where: { id: dto.payoutId },
        data: {
          status: dto.status === 'FAILED' ? 'FAILED' : 'RETURNED',
          failureReason: dto.failureReason,
        },
      });

      this.eventEmitter.emit(
        dto.status === 'RETURNED'
          ? AgncyPayEvent.PAYOUT_RETURNED
          : AgncyPayEvent.PAYOUT_FAILED,
        {
          eventId: uuidv4(),
          timestamp: new Date().toISOString(),
          source: 'PayoutsService',
          payoutId: dto.payoutId,
          walletId: payout.walletId,
          amount: payout.amount.toString(),
          currency,
          failureReason: dto.failureReason,
        },
      );

      return failed;
    }

    return payout;
  }

  async getPayout(payoutId: string): Promise<Payout | null> {
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }

  async listPayoutsByWallet(
    walletId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<Payout[]> {
    return this.prisma.payout.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
