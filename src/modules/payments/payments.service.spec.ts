import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { SplitEngine } from './orchestrator/split-engine.service.js';
import { IdempotencyService } from '../../common/utils/idempotency.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { Decimal } from 'decimal.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('PaymentsService', () => {
  let service: PaymentsService;

  const mockPrisma = {
    $transaction: jest.fn(),
    payment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
    },
  };

  const mockLedgerService = {
    postTransaction: jest.fn(),
    getAccountByType: jest.fn(),
    getTransactionsByReference: jest.fn(),
    reverseTransaction: jest.fn(),
  };

  const mockSplitEngine = {
    computeSplitEntries: jest.fn(),
  };

  const mockIdempotencyService = {
    check: jest.fn(),
    complete: jest.fn(),
    remove: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: SplitEngine, useValue: mockSplitEngine },
        { provide: IdempotencyService, useValue: mockIdempotencyService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // ingestPayment — simple
  // ========================================================================
  describe('ingestPayment (simple)', () => {
    const dto = {
      source: 'API' as const,
      walletId: 'w1',
      amount: '500.00',
      currency: 'USD',
    };

    it('should ingest a simple payment atomically', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w1',
        status: 'ACTIVE',
      });

      // Simulate $transaction executing the callback
      const createdPayment = { id: 'p1', ...dto, status: 'PROCESSING' };
      const settledPayment = { ...createdPayment, status: 'SETTLED', settledAmount: '500.00' };

      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          payment: {
            create: jest.fn().mockResolvedValue(createdPayment),
            update: jest.fn().mockResolvedValue(settledPayment),
          },
        };

        mockLedgerService.getAccountByType
          .mockResolvedValueOnce({ id: 'cash-acc' })
          .mockResolvedValueOnce({ id: 'pay-acc' });
        mockLedgerService.postTransaction.mockResolvedValue({ id: 'tx1' });

        return cb(txMock);
      });

      const result = await service.ingestPayment(dto);

      expect(result.status).toBe('SETTLED');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.PAYMENT_SETTLED,
        expect.objectContaining({
          paymentId: 'p1',
          amount: '500.00',
        }),
      );
    });

    it('should throw NotFoundException for non-existent wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.ingestPayment(dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for suspended wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w1',
        status: 'SUSPENDED',
      });

      await expect(service.ingestPayment(dto)).rejects.toThrow(BadRequestException);
    });

    it('should deduplicate by externalId + source', async () => {
      const dtoWithExternal = {
        ...dto,
        externalId: 'ext-123',
      };

      const existingPayment = { id: 'existing-p', ...dtoWithExternal, status: 'SETTLED' };
      mockPrisma.payment.findUnique.mockResolvedValue(existingPayment);

      const result = await service.ingestPayment(dtoWithExternal);

      expect(result.id).toBe('existing-p');
      // Should NOT call $transaction (skipped due to dedup)
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // ingestPayment — idempotency
  // ========================================================================
  describe('ingestPayment (idempotency)', () => {
    it('should return cached response for duplicate idempotency key', async () => {
      const cachedPayment = { id: 'cached', status: 'SETTLED' };
      mockIdempotencyService.check.mockResolvedValue({
        isNew: false,
        response: cachedPayment,
      });

      const result = await service.ingestPayment(
        { source: 'API' as const, walletId: 'w1', amount: '100.00' },
        'idem-key-123',
      );

      expect(result.id).toBe('cached');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should remove idempotency key on failure', async () => {
      mockIdempotencyService.check.mockResolvedValue({ isNew: true });
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.ingestPayment(
          { source: 'API' as const, walletId: 'nonexistent', amount: '100.00' },
          'idem-key-456',
        ),
      ).rejects.toThrow();

      expect(mockIdempotencyService.remove).toHaveBeenCalledWith('idem-key-456');
    });
  });

  // ========================================================================
  // refundPayment
  // ========================================================================
  describe('refundPayment', () => {
    it('should refund a settled payment', async () => {
      const payment = {
        id: 'p1',
        status: 'SETTLED',
        amount: new Decimal('500.00'),
        settledAmount: new Decimal('500.00'),
        walletId: 'w1',
        currency: 'USD',
      };
      mockPrisma.payment.findUnique.mockResolvedValue(payment);

      const postedTx = {
        id: 'tx1',
        status: 'POSTED',
        originalTransactionId: null,
        entries: [],
      };
      mockLedgerService.getTransactionsByReference.mockResolvedValue([postedTx]);
      mockLedgerService.reverseTransaction.mockResolvedValue({ id: 'rev1' });
      mockPrisma.payment.update.mockResolvedValue({ ...payment, status: 'REFUNDED' });

      const result = await service.refundPayment({
        paymentId: 'p1',
        reason: 'Customer request',
      });

      expect(result.status).toBe('REFUNDED');
      expect(mockLedgerService.reverseTransaction).toHaveBeenCalledWith(
        'tx1',
        'Customer request',
        'REFUND',
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.PAYMENT_REFUNDED,
        expect.any(Object),
      );
    });

    it('should throw NotFoundException for non-existent payment', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.refundPayment({ paymentId: 'nope', reason: 'Test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if payment is not SETTLED', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'PENDING',
      });

      await expect(
        service.refundPayment({ paymentId: 'p1', reason: 'Test' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if refund amount exceeds settled amount', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'SETTLED',
        amount: new Decimal('100.00'),
        settledAmount: new Decimal('100.00'),
      });

      await expect(
        service.refundPayment({ paymentId: 'p1', amount: '150.00', reason: 'Test' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.refundPayment({ paymentId: 'p1', amount: '150.00', reason: 'Test' }),
      ).rejects.toThrow(/exceeds settled amount/);
    });
  });

  // ========================================================================
  // handleChargeback
  // ========================================================================
  describe('handleChargeback', () => {
    it('should process chargeback and reverse ledger entries', async () => {
      const payment = {
        id: 'p1',
        status: 'SETTLED',
        amount: new Decimal('500.00'),
        walletId: 'w1',
        currency: 'USD',
      };
      mockPrisma.payment.findUnique.mockResolvedValue(payment);

      const postedTx = {
        id: 'tx1',
        status: 'POSTED',
        originalTransactionId: null,
      };
      mockLedgerService.getTransactionsByReference.mockResolvedValue([postedTx]);
      mockLedgerService.reverseTransaction.mockResolvedValue({ id: 'cb1' });
      mockPrisma.payment.update.mockResolvedValue({ ...payment, status: 'CHARGEBACKED' });

      const result = await service.handleChargeback({
        paymentId: 'p1',
        reason: 'Unauthorized transaction',
      });

      expect(result.status).toBe('CHARGEBACKED');
      expect(mockLedgerService.reverseTransaction).toHaveBeenCalledWith(
        'tx1',
        expect.stringContaining('Chargeback'),
        'CHARGEBACK',
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.PAYMENT_CHARGEBACKED,
        expect.objectContaining({ paymentId: 'p1' }),
      );
    });

    it('should throw NotFoundException for non-existent payment', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.handleChargeback({ paymentId: 'nope', reason: 'Test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle chargeback even if no posted ledger tx exists', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'FAILED',
        amount: new Decimal('100.00'),
        walletId: 'w1',
        currency: 'USD',
      });
      mockLedgerService.getTransactionsByReference.mockResolvedValue([]);
      mockPrisma.payment.update.mockResolvedValue({
        id: 'p1',
        status: 'CHARGEBACKED',
      });

      // Should NOT throw — just update status
      const result = await service.handleChargeback({
        paymentId: 'p1',
        reason: 'Test',
      });
      expect(result.status).toBe('CHARGEBACKED');
      expect(mockLedgerService.reverseTransaction).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Transaction rollback
  // ========================================================================
  describe('transaction atomicity', () => {
    it('should emit PAYMENT_FAILED event on transaction error', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w1',
        status: 'ACTIVE',
      });
      mockPrisma.$transaction.mockRejectedValue(new Error('DB deadlock'));

      await expect(
        service.ingestPayment({
          source: 'API' as const,
          walletId: 'w1',
          amount: '100.00',
        }),
      ).rejects.toThrow();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.PAYMENT_FAILED,
        expect.objectContaining({
          status: 'FAILED',
          error: 'DB deadlock',
        }),
      );
    });
  });
});
