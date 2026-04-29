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
  PrismaClient,
} from '@prisma/client';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Transaction-aware client types
// ---------------------------------------------------------------------------

/**
 * Prisma interactive-transaction client.
 * Same model API as PrismaClient, minus connection/transaction management.
 */
type PrismaTxClient = Omit<
  PrismaClient,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
>;

/**
 * Union of PrismaService (standalone) or transaction client (within $transaction).
 * Every data-access method in LedgerService accepts this so callers can pass
 * their own transaction handle for cross-service atomicity.
 */
export type DbClient = PrismaService | PrismaTxClient;

/**
 * LedgerService — The absolute source of truth for all money movements.
 *
 * Rules:
 * 1. Every transaction must have entries where SUM(amount) = 0 (double-entry invariant).
 * 2. Balances are NEVER stored — always computed from the ledger entries.
 * 3. All mutations happen inside database transactions for ACID guarantees.
 * 4. Entries use positive = debit, negative = credit convention.
 * 5. Posted transactions are IMMUTABLE — reversals create new transactions linked via originalTransactionId.
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
   * @param dto         The transaction data with balanced entries.
   * @param tx          Optional Prisma transaction client. When provided, the
   *                    ledger write participates in the caller's transaction
   *                    instead of creating its own.
   * @param originalTxId  Optional ID of the transaction being reversed (for reversals only).
   *
   * @throws BadRequestException if the double-entry invariant is violated
   * @throws InternalServerErrorException on database failures
   */
  async postTransaction(
    dto: PostTransactionDto,
    tx?: DbClient,
    originalTxId?: string,
  ): Promise<LedgerTransaction & { entries: LedgerEntry[] }> {
    // 1. Validate the double-entry invariant BEFORE touching the database
    this.validateDoubleEntryInvariant(dto.entries);

    // If a transaction client was provided, run inline (no nested $transaction).
    // Otherwise, create our own transaction for standalone calls.
    if (tx) {
      return this._postTransactionInner(dto, tx, originalTxId);
    }

    try {
      const result = await this.prisma.$transaction(async (innerTx) => {
        return this._postTransactionInner(dto, innerTx as unknown as DbClient, originalTxId);
      });

      this._emitPostSuccess(result, dto);
      return result;
    } catch (error) {
      this._emitPostFailure(dto, error);
      throw error instanceof BadRequestException
        ? error
        : new InternalServerErrorException('Failed to post ledger transaction');
    }
  }

  /**
   * Inner implementation that runs within whatever transaction context is provided.
   */
  private async _postTransactionInner(
    dto: PostTransactionDto,
    db: DbClient,
    originalTxId?: string,
  ): Promise<LedgerTransaction & { entries: LedgerEntry[] }> {
    // Validate all accounts exist
    const accountIds = dto.entries.map((e) => e.accountId);
    const accounts: Account[] = await (db as any).account.findMany({
      where: { id: { in: accountIds } },
    });

    if (accounts.length !== new Set(accountIds).size) {
      const foundIds = new Set(accounts.map((a: Account) => a.id));
      const missing = accountIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(
        `Accounts not found: ${missing.join(', ')}`,
      );
    }

    // Validate currency consistency
    const accountMap = new Map(accounts.map((a: Account) => [a.id, a]));
    for (const entry of dto.entries) {
      const account = accountMap.get(entry.accountId)!;
      const entryCurrency = entry.currency || 'USD';
      if (account.currency !== entryCurrency) {
        throw new BadRequestException(
          `Currency mismatch: entry has ${entryCurrency} but account ${account.id} is ${account.currency}`,
        );
      }
    }

    // Create the transaction + entries atomically
    const transaction = await (db as any).ledgerTransaction.create({
      data: {
        referenceId: dto.referenceId,
        referenceType: dto.referenceType,
        type: dto.type,
        status: 'POSTED',
        description: dto.description,
        postedAt: new Date(),
        originalTransactionId: originalTxId || null,
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

    this.logger.log(
      `Ledger transaction posted: ${transaction.id} (ref: ${dto.referenceId}, type: ${dto.type})`,
    );

    return transaction;
  }

  private _emitPostSuccess(
    result: LedgerTransaction & { entries: LedgerEntry[] },
    dto: PostTransactionDto,
  ) {
    this.eventEmitter.emit(AgncyPayEvent.LEDGER_TRANSACTION_POSTED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'LedgerService',
      transactionId: result.id,
      referenceId: dto.referenceId,
      referenceType: dto.referenceType,
      entryCount: result.entries.length,
    });
  }

  private _emitPostFailure(dto: PostTransactionDto, error: unknown) {
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
  // LOCKING: Pessimistic row lock for balance-critical operations
  // ===========================================================================

  /**
   * Acquire a row-level lock on an account within an active transaction.
   * Any concurrent transaction attempting to lock the same account will BLOCK
   * until this transaction commits, preventing double-spend.
   *
   * MUST be called inside a Prisma interactive transaction.
   */
  async lockAccountForUpdate(accountId: string, tx: DbClient): Promise<void> {
    await (tx as any).$queryRaw`
      SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE
    `;
  }

  // ===========================================================================
  // ACCOUNTS: Create standard accounts for a wallet
  // ===========================================================================

  /**
   * Auto-create the standard set of ledger accounts for a wallet.
   * Every wallet gets: CASH, PAYABLE, RECEIVABLE, CREDIT, FEE, SUSPENSE accounts.
   */
  async createAccountsForWallet(
    walletId: string,
    currency: string = 'USD',
    tx?: DbClient,
  ): Promise<Account[]> {
    const db = tx || this.prisma;
    const accountTypes: AccountType[] = [
      'CASH',
      'PAYABLE',
      'RECEIVABLE',
      'CREDIT',
      'FEE',
      'SUSPENSE',
    ];

    const accounts: Account[] = [];

    for (const type of accountTypes) {
      const existing = await (db as any).account.findUnique({
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

      const account = await (db as any).account.create({
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
   * @param accountId  The account to compute balance for.
   * @param asOfDate   Optional cutoff date for point-in-time balance.
   * @param tx         Optional transaction client. When provided with lockFirst=true,
   *                   the account row is locked first to prevent concurrent modification.
   * @param lockFirst  If true and tx is provided, acquires SELECT FOR UPDATE lock.
   */
  async computeBalanceFromLedger(
    accountId: string,
    asOfDate?: Date,
    tx?: DbClient,
    lockFirst: boolean = false,
  ): Promise<Decimal> {
    const db = tx || this.prisma;

    // Acquire pessimistic lock if requested (prevents double-spend)
    if (lockFirst && tx) {
      await this.lockAccountForUpdate(accountId, tx);
    }

    const where: Record<string, unknown> = {
      accountId,
      transaction: {
        status: 'POSTED',
      },
    };

    if (asOfDate) {
      where.createdAt = { lte: asOfDate };
    }

    const entries = await (db as any).ledgerEntry.findMany({
      where,
      select: { amount: true },
    });

    const balance = entries.reduce(
      (sum: Decimal, entry: { amount: { toString(): string } }) =>
        sum.plus(new Decimal(entry.amount.toString())),
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
    tx?: DbClient,
  ): Promise<Map<string, Decimal>> {
    const db = tx || this.prisma;
    const accounts = await (db as any).account.findMany({
      where: { walletId, currency },
    });

    const balances = new Map<string, Decimal>();

    for (const account of accounts) {
      const balance = await this.computeBalanceFromLedger(
        account.id,
        undefined,
        tx,
      );
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
    tx?: DbClient,
  ): Promise<Account[]> {
    const db = tx || this.prisma;
    return (db as any).account.findMany({
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
    tx?: DbClient,
  ): Promise<Account | null> {
    const db = tx || this.prisma;
    return (db as any).account.findUnique({
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
    tx?: DbClient,
  ): Promise<(LedgerTransaction & { entries: LedgerEntry[] })[]> {
    const db = tx || this.prisma;
    return (db as any).ledgerTransaction.findMany({
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
  // REVERSAL: Create an immutable counter-transaction (NEVER mutate original)
  // ===========================================================================

  /**
   * Create a reversal transaction that exactly mirrors the original.
   * All amounts are negated. Used for refunds and chargebacks.
   *
   * IMMUTABILITY GUARANTEE: The original transaction is NEVER modified.
   * The reversal is a new transaction linked via originalTransactionId.
   */
  async reverseTransaction(
    transactionId: string,
    reason: string,
    type: 'REFUND' | 'CHARGEBACK' | 'ADJUSTMENT',
    tx?: DbClient,
  ): Promise<LedgerTransaction & { entries: LedgerEntry[] }> {
    const db = tx || this.prisma;

    const original = await (db as any).ledgerTransaction.findUnique({
      where: { id: transactionId },
      include: { entries: true, reversals: true },
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

    // Prevent double-reversal: check if a reversal already exists
    if (original.reversals && original.reversals.length > 0) {
      throw new BadRequestException(
        `Transaction ${transactionId} has already been reversed by ${original.reversals[0].id}`,
      );
    }

    // Create reversal entries (negate all amounts)
    const reversalEntries = original.entries.map((entry: LedgerEntry) => ({
      accountId: entry.accountId,
      amount: Money.negate(entry.amount.toString()).toFixed(4),
      currency: entry.currency,
      description: `Reversal: ${reason}`,
    }));

    // Post the reversal as a NEW transaction linked to the original.
    // The original transaction remains POSTED and immutable.
    const reversal = await this.postTransaction(
      {
        referenceId: original.referenceId,
        referenceType: original.referenceType,
        type,
        description: `Reversal of ${transactionId}: ${reason}`,
        entries: reversalEntries,
      },
      tx,
      transactionId, // originalTransactionId linkage
    );

    return reversal;
  }
}
