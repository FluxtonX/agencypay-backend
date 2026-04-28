import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { AgncyPayEvent } from '../../common/constants/events.js';
import type { CreateWalletDto, MapExternalAccountDto } from './dto/wallet.dto.js';
import { v4 as uuidv4 } from 'uuid';
import type { Wallet, ExternalAccount, Account } from '@prisma/client';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new wallet and auto-provision its ledger accounts.
   */
  async createWallet(
    dto: CreateWalletDto,
  ): Promise<Wallet & { accounts: Account[] }> {
    const wallet = await this.prisma.wallet.create({
      data: {
        type: dto.type,
        name: dto.name,
        email: dto.email,
        metadata: (dto.metadata ?? undefined) as any,
      },
    });

    // Auto-create standard ledger accounts
    const accounts = await this.ledgerService.createAccountsForWallet(
      wallet.id,
    );

    this.logger.log(
      `Wallet created: ${wallet.id} (${wallet.type}) with ${accounts.length} accounts`,
    );

    this.eventEmitter.emit(AgncyPayEvent.WALLET_CREATED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'WalletService',
      walletId: wallet.id,
      type: wallet.type,
    });

    return { ...wallet, accounts };
  }

  /**
   * Map an external system ID (e.g., QuickBooks customer) to an internal wallet.
   */
  async mapExternalAccount(
    dto: MapExternalAccountDto,
  ): Promise<ExternalAccount> {
    // Verify wallet exists
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: dto.walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${dto.walletId} not found`);
    }

    // Check for existing mapping
    const existing = await this.prisma.externalAccount.findUnique({
      where: {
        provider_externalId: {
          provider: dto.provider,
          externalId: dto.externalId,
        },
      },
    });

    if (existing) {
      if (existing.walletId === dto.walletId) {
        return existing; // Idempotent — same mapping already exists
      }
      throw new ConflictException(
        `External account ${dto.provider}:${dto.externalId} is already mapped to wallet ${existing.walletId}`,
      );
    }

    const externalAccount = await this.prisma.externalAccount.create({
      data: {
        walletId: dto.walletId,
        provider: dto.provider,
        externalId: dto.externalId,
        externalType: dto.externalType,
        metadata: (dto.metadata ?? undefined) as any,
      },
    });

    this.logger.log(
      `External account mapped: ${dto.provider}:${dto.externalId} → wallet ${dto.walletId}`,
    );

    this.eventEmitter.emit(AgncyPayEvent.WALLET_MAPPED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'WalletService',
      walletId: dto.walletId,
      provider: dto.provider,
      externalId: dto.externalId,
    });

    return externalAccount;
  }

  /**
   * Resolve an external ID to an internal wallet.
   */
  async resolveWalletByExternalId(
    provider: string,
    externalId: string,
  ): Promise<Wallet | null> {
    const externalAccount = await this.prisma.externalAccount.findUnique({
      where: {
        provider_externalId: {
          provider,
          externalId,
        },
      },
      include: { wallet: true },
    });

    return externalAccount?.wallet ?? null;
  }

  /**
   * Get wallet by ID with accounts.
   */
  async getWallet(
    walletId: string,
  ): Promise<(Wallet & { accounts: Account[] }) | null> {
    return this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { accounts: true },
    });
  }

  /**
   * List all wallets with pagination.
   */
  async listWallets(
    limit: number = 20,
    offset: number = 0,
  ): Promise<Wallet[]> {
    return this.prisma.wallet.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get wallet with full balance information (computed from ledger).
   */
  async getWalletWithBalances(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { accounts: true },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const balances = await this.ledgerService.computeWalletBalances(walletId);
    const balanceMap: Record<string, string> = {};
    for (const [type, balance] of balances) {
      balanceMap[type] = balance.toFixed(4);
    }

    return {
      ...wallet,
      balances: balanceMap,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Suspend a wallet (e.g., for fraud or compliance hold).
   */
  async suspendWallet(walletId: string, reason: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.update({
      where: { id: walletId },
      data: {
        status: 'SUSPENDED',
        metadata: { suspendedReason: reason, suspendedAt: new Date().toISOString() },
      },
    });

    this.logger.warn(`Wallet suspended: ${walletId} — Reason: ${reason}`);
    return wallet;
  }
}
