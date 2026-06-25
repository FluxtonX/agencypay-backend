import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { Decimal } from 'decimal.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('WalletService', () => {
  let service: WalletService;

  const mockPrisma = {
    wallet: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    externalAccount: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  const mockLedgerService = {
    createAccountsForWallet: jest.fn(),
    computeWalletBalances: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // createWallet
  // ========================================================================
  describe('createWallet', () => {
    it('should create wallet and auto-provision accounts', async () => {
      const wallet = { id: 'w1', type: 'BUSINESS', name: 'Test Agency', status: 'ACTIVE' };
      const accounts = [
        { id: 'a1', type: 'CASH' },
        { id: 'a2', type: 'PAYABLE' },
      ];

      mockPrisma.wallet.create.mockResolvedValue(wallet);
      mockLedgerService.createAccountsForWallet.mockResolvedValue(accounts);

      const result = await service.createWallet({
        type: 'BUSINESS' as any,
        name: 'Test Agency',
      });

      expect(result.id).toBe('w1');
      expect(result.accounts).toHaveLength(2);
      expect(mockLedgerService.createAccountsForWallet).toHaveBeenCalledWith('w1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.WALLET_CREATED,
        expect.objectContaining({ walletId: 'w1' }),
      );
    });

    it('should handle email and metadata', async () => {
      const wallet = { id: 'w2', type: 'INDIVIDUAL', name: 'Test User', email: 'test@example.com' };
      mockPrisma.wallet.create.mockResolvedValue(wallet);
      mockLedgerService.createAccountsForWallet.mockResolvedValue([]);

      const result = await service.createWallet({
        type: 'INDIVIDUAL' as any,
        name: 'Test User',
        email: 'test@example.com',
        metadata: { referral: 'XYZ' },
      });

      expect(mockPrisma.wallet.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'test@example.com',
            metadata: { referral: 'XYZ' },
          }),
        }),
      );
    });
  });

  // ========================================================================
  // mapExternalAccount
  // ========================================================================
  describe('mapExternalAccount', () => {
    it('should map a new external account', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', status: 'ACTIVE' });
      mockPrisma.externalAccount.findUnique.mockResolvedValue(null);
      mockPrisma.externalAccount.create.mockResolvedValue({
        id: 'ea1',
        walletId: 'w1',
        provider: 'stripe',
        externalId: 'cust_123',
      });

      const result = await service.mapExternalAccount({
        walletId: 'w1',
        provider: 'stripe',
        externalId: 'cust_123',
      });

      expect(result.provider).toBe('stripe');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.WALLET_MAPPED,
        expect.any(Object),
      );
    });

    it('should throw NotFoundException for non-existent wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.mapExternalAccount({
          walletId: 'nonexistent',
          provider: 'stripe',
          externalId: 'cust_123',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return existing mapping if idempotent (same wallet)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1' });
      mockPrisma.externalAccount.findUnique.mockResolvedValue({
        id: 'ea1',
        walletId: 'w1',
        provider: 'stripe',
        externalId: 'cust_123',
      });

      const result = await service.mapExternalAccount({
        walletId: 'w1',
        provider: 'stripe',
        externalId: 'cust_123',
      });

      expect(result.id).toBe('ea1');
      // Should NOT create a new one
      expect(mockPrisma.externalAccount.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if mapped to different wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w2' });
      mockPrisma.externalAccount.findUnique.mockResolvedValue({
        id: 'ea1',
        walletId: 'w1', // Different wallet
        provider: 'stripe',
        externalId: 'cust_123',
      });

      await expect(
        service.mapExternalAccount({
          walletId: 'w2',
          provider: 'stripe',
          externalId: 'cust_123',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ========================================================================
  // resolveWalletByExternalId
  // ========================================================================
  describe('resolveWalletByExternalId', () => {
    it('should resolve wallet from external ID', async () => {
      mockPrisma.externalAccount.findUnique.mockResolvedValue({
        wallet: { id: 'w1', name: 'Test' },
      });

      const result = await service.resolveWalletByExternalId('stripe', 'cust_123');
      expect(result?.id).toBe('w1');
    });

    it('should return null for unknown external ID', async () => {
      mockPrisma.externalAccount.findUnique.mockResolvedValue(null);

      const result = await service.resolveWalletByExternalId('stripe', 'unknown');
      expect(result).toBeNull();
    });
  });

  // ========================================================================
  // getWalletWithBalances
  // ========================================================================
  describe('getWalletWithBalances', () => {
    it('should return wallet with computed balances', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w1',
        name: 'Test',
        accounts: [{ id: 'a1', type: 'CASH' }],
      });

      const balanceMap = new Map<string, Decimal>();
      balanceMap.set('CASH', new Decimal('500.0000'));
      balanceMap.set('PAYABLE', new Decimal('-300.0000'));
      mockLedgerService.computeWalletBalances.mockResolvedValue(balanceMap);

      const result = await service.getWalletWithBalances('w1');

      expect(result.balances.CASH).toBe('500.0000');
      expect(result.balances.PAYABLE).toBe('-300.0000');
      expect(result.computedAt).toBeDefined();
    });

    it('should throw NotFoundException for unknown wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.getWalletWithBalances('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ========================================================================
  // suspendWallet
  // ========================================================================
  describe('suspendWallet', () => {
    it('should mark wallet as SUSPENDED with reason', async () => {
      mockPrisma.wallet.update.mockResolvedValue({
        id: 'w1',
        status: 'SUSPENDED',
        metadata: { suspendedReason: 'Fraud', suspendedAt: expect.any(String) },
      });

      const result = await service.suspendWallet('w1', 'Fraud');

      expect(result.status).toBe('SUSPENDED');
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SUSPENDED',
            metadata: expect.objectContaining({ suspendedReason: 'Fraud' }),
          }),
        }),
      );
    });
  });
});
