import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ReconciliationService } from './reconciliation.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from 'decimal.js';
import { AgncyPayEvent } from '../../common/constants/events.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('ReconciliationService', () => {
  let service: ReconciliationService;

  const mockPrisma = {
    payment: { findUnique: jest.fn() },
    payout: { findUnique: jest.fn() },
    ledgerEntry: { findMany: jest.fn() },
    ledgerTransaction: { count: jest.fn() },
    reconciliation: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockLedgerService = {
    getTransactionsByReference: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<ReconciliationService>(ReconciliationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // reconcilePayment
  // ========================================================================
  describe('reconcilePayment', () => {
    it('should return MATCHED for correctly balanced payment', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        amount: new Decimal('500.00'),
      });

      mockLedgerService.getTransactionsByReference.mockResolvedValue([
        {
          id: 'tx1',
          status: 'POSTED',
          entries: [
            { amount: new Decimal('500.00') },  // Debit
            { amount: new Decimal('-500.00') },  // Credit
          ],
        },
      ]);

      mockPrisma.reconciliation.create.mockImplementation(async ({ data }) => ({
        id: 'rec-1',
        ...data,
      }));

      const result = await service.reconcilePayment('p1');

      expect(result.status).toBe('MATCHED');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.RECONCILIATION_MATCHED,
        expect.objectContaining({ entityId: 'p1' }),
      );
    });

    it('should return MISMATCHED when ledger amounts differ', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p2',
        amount: new Decimal('500.00'),
      });

      // Ledger shows only 400 debit (discrepancy of 100)
      mockLedgerService.getTransactionsByReference.mockResolvedValue([
        {
          id: 'tx2',
          status: 'POSTED',
          entries: [
            { amount: new Decimal('400.00') },
            { amount: new Decimal('-400.00') },
          ],
        },
      ]);

      mockPrisma.reconciliation.create.mockImplementation(async ({ data }) => ({
        id: 'rec-2',
        ...data,
      }));

      const result = await service.reconcilePayment('p2');

      expect(result.status).toBe('MISMATCHED');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.RECONCILIATION_MISMATCHED,
        expect.objectContaining({ entityId: 'p2' }),
      );
    });

    it('should throw for non-existent payment', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.reconcilePayment('nope')).rejects.toThrow(
        /not found/,
      );
    });

    it('should detect unbalanced ledger transactions', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p3',
        amount: new Decimal('100.00'),
      });

      // Transaction entries don't sum to zero (corrupted ledger)
      mockLedgerService.getTransactionsByReference.mockResolvedValue([
        {
          id: 'tx3',
          status: 'POSTED',
          entries: [
            { amount: new Decimal('100.00') },
            { amount: new Decimal('-99.99') }, // Off by 0.01
          ],
        },
      ]);

      mockPrisma.reconciliation.create.mockImplementation(async ({ data }) => ({
        id: 'rec-3',
        ...data,
      }));

      const result = await service.reconcilePayment('p3');

      expect(result.status).toBe('MISMATCHED');
    });

    it('should only consider POSTED transactions (ignore PENDING)', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p4',
        amount: new Decimal('200.00'),
      });

      mockLedgerService.getTransactionsByReference.mockResolvedValue([
        {
          id: 'tx-pending',
          status: 'PENDING', // Should be skipped
          entries: [
            { amount: new Decimal('200.00') },
            { amount: new Decimal('-200.00') },
          ],
        },
        {
          id: 'tx-posted',
          status: 'POSTED',
          entries: [
            { amount: new Decimal('200.00') },
            { amount: new Decimal('-200.00') },
          ],
        },
      ]);

      mockPrisma.reconciliation.create.mockImplementation(async ({ data }) => ({
        id: 'rec-4',
        ...data,
      }));

      const result = await service.reconcilePayment('p4');

      expect(result.status).toBe('MATCHED');
    });
  });

  // ========================================================================
  // auditGlobalLedgerBalance
  // ========================================================================
  describe('auditGlobalLedgerBalance', () => {
    it('should return balanced=true when global sum is zero', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { amount: new Decimal('1000.00') },
        { amount: new Decimal('-1000.00') },
        { amount: new Decimal('500.00') },
        { amount: new Decimal('-500.00') },
      ]);
      mockPrisma.ledgerTransaction.count.mockResolvedValue(2);

      const result = await service.auditGlobalLedgerBalance();

      expect(result.balanced).toBe(true);
      expect(result.totalSum).toBe('0');
      expect(result.transactionCount).toBe(2);
      expect(result.entryCount).toBe(4);
    });

    it('should return balanced=false and emit event when sum is non-zero', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([
        { amount: new Decimal('1000.00') },
        { amount: new Decimal('-999.99') }, // Off by 0.01
      ]);
      mockPrisma.ledgerTransaction.count.mockResolvedValue(1);

      const result = await service.auditGlobalLedgerBalance();

      expect(result.balanced).toBe(false);
      expect(result.totalSum).toBe('0.01');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.RECONCILIATION_FAILED,
        expect.objectContaining({
          entityType: 'global',
          discrepancy: '0.01',
        }),
      );
    });

    it('should handle empty ledger gracefully', async () => {
      mockPrisma.ledgerEntry.findMany.mockResolvedValue([]);
      mockPrisma.ledgerTransaction.count.mockResolvedValue(0);

      const result = await service.auditGlobalLedgerBalance();

      expect(result.balanced).toBe(true);
      expect(result.totalSum).toBe('0');
      expect(result.entryCount).toBe(0);
    });
  });
});
