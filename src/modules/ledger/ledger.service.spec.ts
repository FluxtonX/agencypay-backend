import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { LedgerService } from './ledger.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxService } from '../outbox/outbox.service.js';
import { BadRequestException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { AgncyPayEvent } from '../../common/constants/events.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('LedgerService', () => {
  let service: LedgerService;
  let eventEmitter: EventEmitter2;

  const mockPrisma = {
    $transaction: jest.fn(),
    account: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    ledgerTransaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    ledgerEntry: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockOutboxService = {
    recordEvent: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: OutboxService, useValue: mockOutboxService },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // validateDoubleEntryInvariant
  // ========================================================================
  describe('validateDoubleEntryInvariant', () => {
    it('should pass for balanced entries', () => {
      const entries = [
        { accountId: 'acc1', amount: '100.00' },
        { accountId: 'acc2', amount: '-100.00' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).not.toThrow();
    });

    it('should pass for multi-party balanced entries', () => {
      const entries = [
        { accountId: 'acc1', amount: '1000.00' },
        { accountId: 'acc2', amount: '-700.00' },
        { accountId: 'acc3', amount: '-300.00' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).not.toThrow();
    });

    it('should throw BadRequestException for imbalanced entries', () => {
      const entries = [
        { accountId: 'acc1', amount: '100.00' },
        { accountId: 'acc2', amount: '-99.00' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(BadRequestException);
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(
        /Double-entry invariant violated/,
      );
    });

    it('should throw if fewer than 2 entries', () => {
      const entries = [{ accountId: 'acc1', amount: '100.00' }];
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(BadRequestException);
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(
        /at least 2 entries/,
      );
    });

    it('should throw for empty entries', () => {
      expect(() => service.validateDoubleEntryInvariant([])).toThrow(BadRequestException);
    });

    it('should handle very small rounding amounts (precision edge case)', () => {
      // These should sum to exactly zero with proper decimal arithmetic
      const entries = [
        { accountId: 'acc1', amount: '333.3333' },
        { accountId: 'acc2', amount: '333.3333' },
        { accountId: 'acc3', amount: '333.3334' },
        { accountId: 'acc4', amount: '-1000.0000' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).not.toThrow();
    });

    it('should catch tiny imbalances that floating-point might miss', () => {
      const entries = [
        { accountId: 'acc1', amount: '0.0001' },
        { accountId: 'acc2', amount: '0.0000' }, // off by 0.0001
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(BadRequestException);
    });

    it('should handle large amounts correctly', () => {
      const entries = [
        { accountId: 'acc1', amount: '999999999999.9999' },
        { accountId: 'acc2', amount: '-999999999999.9999' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).not.toThrow();
    });

    it('should emit LEDGER_INVARIANT_VIOLATION event on violation', () => {
      const entries = [
        { accountId: 'acc1', amount: '100.00' },
        { accountId: 'acc2', amount: '-50.00' },
      ];
      try {
        service.validateDoubleEntryInvariant(entries);
      } catch {}
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.LEDGER_INVARIANT_VIOLATION,
        expect.objectContaining({ entries }),
      );
    });
  });

  // ========================================================================
  // postTransaction
  // ========================================================================
  describe('postTransaction', () => {
    const dto = {
      referenceId: 'ref1',
      referenceType: 'payment',
      type: 'PAYMENT_RECEIVED' as any,
      entries: [
        { accountId: 'acc1', amount: '100.00', currency: 'USD' },
        { accountId: 'acc2', amount: '-100.00', currency: 'USD' },
      ],
    };

    it('should post a balanced transaction', async () => {
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'acc1', currency: 'USD' },
        { id: 'acc2', currency: 'USD' },
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.ledgerTransaction.create.mockResolvedValue({
        id: 'tx1',
        ...dto,
        entries: dto.entries.map((e) => ({ ...e, id: 'entry1' })),
      });
      mockOutboxService.recordEvent.mockResolvedValue(undefined);

      const result = await service.postTransaction(dto);

      expect(result.id).toBe('tx1');
      expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.LEDGER_TRANSACTION_POSTED,
        expect.any(Object),
      );
    });

    it('should throw if currency mismatch', async () => {
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'acc1', currency: 'USD' },
        { id: 'acc2', currency: 'EUR' }, // Mismatch
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

      await expect(service.postTransaction(dto)).rejects.toThrow(BadRequestException);
    });

    it('should throw if accounts not found', async () => {
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'acc1', currency: 'USD' },
        // acc2 missing
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

      await expect(service.postTransaction(dto)).rejects.toThrow(BadRequestException);
    });

    it('should emit LEDGER_TRANSACTION_FAILED event on database error', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.postTransaction(dto)).rejects.toThrow();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.LEDGER_TRANSACTION_FAILED,
        expect.objectContaining({
          referenceId: 'ref1',
        }),
      );
    });

    it('should work with an external transaction client', async () => {
      const txClient = {
        account: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'acc1', currency: 'USD' },
            { id: 'acc2', currency: 'USD' },
          ]),
        },
        ledgerTransaction: {
          create: jest.fn().mockResolvedValue({
            id: 'tx-ext',
            ...dto,
            entries: dto.entries.map((e) => ({ ...e, id: 'entry-ext' })),
          }),
        },
        outboxEvent: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      mockOutboxService.recordEvent.mockResolvedValue(undefined);

      const result = await service.postTransaction(dto, txClient as any);

      expect(result.id).toBe('tx-ext');
      // When using external tx, it should NOT call $transaction on its own
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should reject duplicate accountIds with different currencies', async () => {
      const badDto = {
        referenceId: 'ref1',
        referenceType: 'payment',
        type: 'PAYMENT_RECEIVED' as any,
        entries: [
          { accountId: 'acc1', amount: '100.00', currency: 'USD' },
          { accountId: 'acc1', amount: '-100.00', currency: 'EUR' },
        ],
      };
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'acc1', currency: 'USD' },
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

      // acc1 is USD, but second entry says EUR → currency mismatch
      await expect(service.postTransaction(badDto)).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================================================
  // computeBalanceFromLedger
  // ========================================================================
  describe('computeBalanceFromLedger', () => {
    it('should sum entries correctly', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { amount: new Decimal('100.00') },
        { amount: new Decimal('50.00') },
        { amount: new Decimal('-25.00') },
      ]);

      const balance = await service.computeBalanceFromLedger('acc1');
      expect(balance.toFixed(2)).toBe('125.00');
    });

    it('should return zero if no entries', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      const balance = await service.computeBalanceFromLedger('acc1');
      expect(balance.isZero()).toBe(true);
    });

    it('should handle negative balance correctly', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { amount: new Decimal('-500.00') },
        { amount: new Decimal('100.00') },
      ]);

      const balance = await service.computeBalanceFromLedger('acc1');
      expect(balance.toFixed(2)).toBe('-400.00');
    });

    it('should filter by asOfDate when provided', async () => {
      const cutoff = new Date('2026-01-01');
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);

      await service.computeBalanceFromLedger('acc1', cutoff);

      expect(mockPrisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { lte: cutoff },
          }),
        }),
      );
    });

    it('should maintain high precision', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { amount: new Decimal('0.0001') },
        { amount: new Decimal('0.0002') },
        { amount: new Decimal('0.0003') },
      ]);

      const balance = await service.computeBalanceFromLedger('acc1');
      expect(balance.toFixed(4)).toBe('0.0006');
    });
  });

  // ========================================================================
  // createAccountsForWallet
  // ========================================================================
  describe('createAccountsForWallet', () => {
    it('should create all 6 standard accounts', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null); // None exist
      mockPrisma.account.create.mockImplementation(async ({ data }) => ({
        id: `${data.type}-id`,
        ...data,
      }));

      const accounts = await service.createAccountsForWallet('wallet1');

      expect(accounts).toHaveLength(6);
      expect(mockPrisma.account.create).toHaveBeenCalledTimes(6);
      const types = accounts.map((a) => a.type);
      expect(types).toContain('CASH');
      expect(types).toContain('PAYABLE');
      expect(types).toContain('RECEIVABLE');
      expect(types).toContain('CREDIT');
      expect(types).toContain('FEE');
      expect(types).toContain('SUSPENSE');
    });

    it('should not recreate accounts that already exist', async () => {
      const existing = { id: 'existing-cash', walletId: 'wallet1', type: 'CASH', currency: 'USD' };
      mockPrisma.account.findUnique
        .mockResolvedValueOnce(existing)  // CASH exists
        .mockResolvedValue(null);         // rest don't
      mockPrisma.account.create.mockImplementation(async ({ data }) => ({
        id: `${data.type}-id`,
        ...data,
      }));

      const accounts = await service.createAccountsForWallet('wallet1');

      expect(accounts).toHaveLength(6);
      expect(mockPrisma.account.create).toHaveBeenCalledTimes(5); // 5 new, 1 existing
    });
  });

  // ========================================================================
  // reverseTransaction
  // ========================================================================
  describe('reverseTransaction', () => {
    const originalTx = {
      id: 'tx1',
      referenceId: 'ref1',
      referenceType: 'payment',
      type: 'PAYMENT_RECEIVED',
      status: 'POSTED',
      entries: [
        { accountId: 'acc1', amount: new Decimal('100.00'), currency: 'USD' },
        { accountId: 'acc2', amount: new Decimal('-100.00'), currency: 'USD' },
      ],
      reversals: [],
    };

    it('should create a reversal with negated amounts', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(originalTx);
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'acc1', currency: 'USD' },
        { id: 'acc2', currency: 'USD' },
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

      const postSpy = jest
        .spyOn(service, 'postTransaction')
        .mockResolvedValue({ id: 'rev1' } as any);

      await service.reverseTransaction('tx1', 'Testing reversal', 'REFUND');

      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'REFUND',
          entries: [
            expect.objectContaining({ amount: '-100.0000' }),
            expect.objectContaining({ amount: '100.0000' }),
          ],
        }),
        undefined,
        'tx1',
      );
    });

    it('should prevent double reversal', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
        ...originalTx,
        reversals: [{ id: 'rev_already' }],
      });

      await expect(
        service.reverseTransaction('tx1', 'reason', 'REFUND'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reverseTransaction('tx1', 'reason', 'REFUND'),
      ).rejects.toThrow(/already been reversed/);
    });

    it('should throw for non-POSTED transaction', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
        ...originalTx,
        status: 'PENDING',
      });

      await expect(
        service.reverseTransaction('tx1', 'reason', 'REFUND'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reverseTransaction('tx1', 'reason', 'REFUND'),
      ).rejects.toThrow(/Cannot reverse transaction in status/);
    });

    it('should throw for non-existent transaction', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);

      await expect(
        service.reverseTransaction('nonexistent', 'reason', 'REFUND'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle chargeback type reversal', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(originalTx);
      const postSpy = jest
        .spyOn(service, 'postTransaction')
        .mockResolvedValue({ id: 'cb1' } as any);

      await service.reverseTransaction('tx1', 'Fraud', 'CHARGEBACK');

      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CHARGEBACK' }),
        undefined,
        'tx1',
      );
    });
  });

  // ========================================================================
  // computeWalletBalances
  // ========================================================================
  describe('computeWalletBalances', () => {
    it('should return balances for all account types', async () => {
      mockPrisma.account.findMany.mockResolvedValue([
        { id: 'cash-acc', type: 'CASH', walletId: 'w1', currency: 'USD' },
        { id: 'pay-acc', type: 'PAYABLE', walletId: 'w1', currency: 'USD' },
      ]);

      // Mock balance for each account
      mockPrisma.ledgerEntry.findMany
        .mockResolvedValueOnce([{ amount: new Decimal('500.00') }])
        .mockResolvedValueOnce([{ amount: new Decimal('-300.00') }]);

      const balances = await service.computeWalletBalances('w1');

      expect(balances.get('CASH')?.toFixed(2)).toBe('500.00');
      expect(balances.get('PAYABLE')?.toFixed(2)).toBe('-300.00');
    });
  });
});
