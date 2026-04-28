import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { Money } from '../../common/utils/money.util.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import type { PostTransactionDto } from './dto/ledger.dto.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  AccountType,
  TransactionStatus,
  LedgerTransaction,
  LedgerEntry,
  Account,
} from '@prisma/client';
import Decimal from 'decimal.js';

/**
 * LedgerService — The absolute source of truth for all money movements.
 *
 * Rules:
 * 1. Every transaction must have entries where SUM(amount) = 0 (double-entry invariant).
 * 2. Balances are NEVER stored — always computed from the ledger entries.
 * 3. All mutations happen inside database transactions for ACID guarantees.
 * 4. Entries use positive = debit, negative = credit convention.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ===========================================================================
  // CORE: Post a ledger transaction
  // ===========================================================================

  /**
   * Post a balanced transaction to the ledger.
   * This is the ONLY way money moves in the system.
   *
   * @throws BadRequestException if the double-entry invariant is violated
   * @throws InternalServerErrorException on database failures
   */
  async postTransaction(
    dto: PostTransactionDto,
  ): Promise<LedgerTransaction & { entries: LedgerEntry[] }> {
    // 1. Validate the double-entry invariant BEFORE touching the database
    this.validateDoubleEntryInvariant(dto.entries);

    // 2. Validate all accounts exist
    const accountIds = dto.entries.map((e) => e.accountId);
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
    });

    if (accounts.length !== new Set(accountIds).size) {
      const foundIds = new Set(accounts.map((a) => a.id));
      const missing = accountIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Accounts not found: ${missing.join(', ')}`,
      );
    }

    // 3. Validate currency consistency
    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    for (const entry of dto.entries) {
      const account = accountMap.get(entry.accountId)!;
      const entryCurrency = entry.currency || 'USD';
      if (account.currency !== entryCurrency) {
        throw new BadRequestException(
          `Currency mismatch: entry has ${entryCurrency} but account ${account.id} is ${account.currency}`,
        );
      }
    }

    // 4. Execute within a database transaction for atomicity
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const transaction = await tx.ledgerTransaction.create({
          data: {
            referenceId: dto.referenceId,
            referenceType: dto.referenceType,
            type: dto.type,
            status: 'POSTED',
            description: dto.description,
            postedAt: new Date(),
            entries: {
              create: dto.entries.map((entry) => ({
                accountId: entry.accountId,
                amount: entry.amount,
                currency: entry.currency || 'USD',
                description: entry.description,
              })),
            },
          },
          include: { entries: true },
        });

        return transaction;
      });

      this.logger.log(
        `Ledger transaction posted: ${result.id} (ref: ${dto.referenceId}, type: ${dto.type})`,
      );

      // 5. Emit domain event (after commit)
      this.eventEmitter.emit(AgncyPayEvent.LEDGER_TRANSACTION_POSTED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'LedgerService',
        transactionId: result.id,
        referenceId: dto.referenceId,
        referenceType: dto.referenceType,
        entryCount: result.entries.length,
      });

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to post ledger transaction for ref: ${dto.referenceId}`,
        error instanceof Error ? error.stack : String(error),
      );

      this.eventEmitter.emit(AgncyPayEvent.LEDGER_TRANSACTION_FAILED, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'LedgerService',
        referenceId: dto.referenceId,
        referenceType: dto.referenceType,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new InternalServerErrorException(
        'Failed to post ledger transaction',
      );
    }
  }

  // ===========================================================================
  // INVARIANT: Validate double-entry (sum must be zero)
  // ===========================================================================

  /**
   * Validate that the sum of all entries is exactly zero.
   * This is the core invariant of double-entry accounting.
   */
  validateDoubleEntryInvariant(
    entries: { amount: string; accountId: string }[],
  ): void {
    if (!entries || entries.length < 2) {
      throw new BadRequestException(
        'A ledger transaction must have at least 2 entries',
      );
    }

    const sum = Money.sum(entries.map((e) => e.amount));

    if (!Money.isZero(sum)) {
      this.logger.error(
        `Double-entry invariant violation: sum = ${sum.toString()}, entries = ${JSON.stringify(entries)}`,
      );

      this.eventEmitter.emit(AgncyPayEvent.LEDGER_INVARIANT_VIOLATION, {
        eventId: uuidv4(),
        timestamp: new Date().toISOString(),
        source: 'LedgerService',
        sum: sum.toString(),
        entries,
      });

      throw new BadRequestException(
        `Double-entry invariant violated: entries sum to ${sum.toString()}, must be 0`,
      );
    }
  }

  // ===========================================================================
  // ACCOUNTS: Create standard accounts for a wallet
  // ===========================================================================

  /**
   * Auto-create the standard set of ledger accounts for a wallet.
   * Every wallet gets: CASH, PAYABLE, RECEIVABLE, CREDIT, FEE accounts.
   */
  async createAccountsForWallet(
    walletId: string,
    currency: string = 'USD',
  ): Promise<Account[]> {
    const accountTypes: AccountType[] = [
      'CASH',
      'PAYABLE',
      'RECEIVABLE',
      'CREDIT',
      'FEE',
    ];

    const accounts: Account[] = [];

    for (const type of accountTypes) {
      const existing = await this.prisma.account.findUnique({
        where: {
          walletId_type_currency: {
            walletId,
            type,
            currency,
          },
        },
      });

      if (existing) {
        accounts.push(existing);
        continue;
      }

      const account = await this.prisma.account.create({
        data: {
          walletId,
          type,
          currency,
        },
      });
      accounts.push(account);
    }

    this.logger.log(
      `Created ${accounts.length} accounts for wallet ${walletId}`,
    );
    return accounts;
  }

  // ===========================================================================
  // BALANCE: Compute from ledger entries (never stored)
  // ===========================================================================

  /**
   * Compute the current balance of an account by summing all posted ledger entries.
   * This is the ONLY way to get a balance — it is never cached or stored.
   *
   * @param accountId The account to compute balance for
   * @param asOfDate Optional cutoff date for point-in-time balance
   */
  async computeBalanceFromLedger(
    accountId: string,
    asOfDate?: Date,
  ): Promise<Decimal> {
    const where: Record<string, unknown> = {
      accountId,
      transaction: {
        status: 'POSTED',
      },
    };

    if (asOfDate) {
      where.createdAt = { lte: asOfDate };
    }

    const entries = await this.prisma.ledgerEntry.findMany({
      where,
      select: { amount: true },
    });

    const balance = entries.reduce(
      (sum, entry) => sum.plus(new Decimal(entry.amount.toString())),
      Money.ZERO,
    );

    return balance;
  }

  /**
   * Compute balances for ALL accounts of a wallet.
   * Returns a map of accountType → balance.
   */
  async computeWalletBalances(
    walletId: string,
    currency: string = 'USD',
  ): Promise<Map<string, Decimal>> {
    const accounts = await this.prisma.account.findMany({
      where: { walletId, currency },
    });

    const balances = new Map<string, Decimal>();

    for (const account of accounts) {
      const balance = await this.computeBalanceFromLedger(account.id);
      balances.set(account.type, balance);
    }

    return balances;
  }

  // ===========================================================================
  // QUERY: Fetch accounts and transactions
  // ===========================================================================

  async getAccountsByWallet(
    walletId: string,
    currency?: string,
  ): Promise<Account[]> {
    return this.prisma.account.findMany({
      where: {
        walletId,
        ...(currency ? { currency } : {}),
      },
    });
  }

  async getAccountByType(
    walletId: string,
    type: AccountType,
    currency: string = 'USD',
  ): Promise<Account | null> {
    return this.prisma.account.findUnique({
      where: {
        walletId_type_currency: {
          walletId,
          type,
          currency,
        },
      },
    });
  }

  async getTransactionsByReference(
    referenceId: string,
    referenceType: string,
  ): Promise<(LedgerTransaction & { entries: LedgerEntry[] })[]> {
    return this.prisma.ledgerTransaction.findMany({
      where: { referenceId, referenceType },
      include: { entries: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getEntriesByAccount(
    accountId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<LedgerEntry[]> {
    return this.prisma.ledgerEntry.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  // ===========================================================================
  // REVERSAL: Reverse a posted transaction (for refunds, chargebacks)
  // ===========================================================================

  /**
   * Create a reversal transaction that exactly mirrors the original.
   * All amounts are negated. Used for refunds and chargebacks.
   */
  async reverseTransaction(
    transactionId: string,
    reason: string,
    type: 'REFUND' | 'CHARGEBACK' | 'ADJUSTMENT',
  ): Promise<LedgerTransaction & { entries: LedgerEntry[] }> {
    const original = await this.prisma.ledgerTransaction.findUnique({
      where: { id: transactionId },
      include: { entries: true },
    });

    if (!original) {
      throw new BadRequestException(
        `Transaction ${transactionId} not found`,
      );
    }

    if (original.status !== 'POSTED') {
      throw new BadRequestException(
        `Cannot reverse transaction in status: ${original.status}`,
      );
    }

    // Create reversal entries (negate all amounts)
    const reversalEntries = original.entries.map((entry) => ({
      accountId: entry.accountId,
      amount: Money.negate(entry.amount.toString()).toFixed(4),
      currency: entry.currency,
      description: `Reversal: ${reason}`,
    }));

    // Post the reversal
    const reversal = await this.postTransaction({
      referenceId: original.referenceId,
      referenceType: original.referenceType,
      type,
      description: `Reversal of ${transactionId}: ${reason}`,
      entries: reversalEntries,
    });

    // Mark original as reversed
    await this.prisma.ledgerTransaction.update({
      where: { id: transactionId },
      data: { status: 'REVERSED' },
    });

    return reversal;
  }
}
