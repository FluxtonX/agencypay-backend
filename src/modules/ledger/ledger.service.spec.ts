import { Test, TestingModule } from '@nestjs/testing';
import { LedgerService } from './ledger.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { Money } from '../../common/utils/money.util.js';
import { Decimal } from 'decimal.js';
import { AgncyPayEvent } from '../../common/constants/events.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('LedgerService', () => {
  let service: LedgerService;
  let prisma: PrismaService;
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
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
    prisma = module.get<PrismaService>(PrismaService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateDoubleEntryInvariant', () => {
    it('should pass for balanced entries', () => {
      const entries = [
        { accountId: 'acc1', amount: '100.00' },
        { accountId: 'acc2', amount: '-100.00' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).not.toThrow();
    });

    it('should throw BadRequestException for imbalanced entries', () => {
      const entries = [
        { accountId: 'acc1', amount: '100.00' },
        { accountId: 'acc2', amount: '-99.00' },
      ];
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(BadRequestException);
    });

    it('should throw if fewer than 2 entries', () => {
      const entries = [{ accountId: 'acc1', amount: '100.00' }];
      expect(() => service.validateDoubleEntryInvariant(entries)).toThrow(BadRequestException);
    });
  });

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
        entries: dto.entries.map(e => ({ ...e, id: 'entry1' })),
      });

      const result = await service.postTransaction(dto);

      expect(result.id).toBe('tx1');
      expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(AgncyPayEvent.LEDGER_TRANSACTION_POSTED, expect.any(Object));
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
  });

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
  });

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
      
      const postSpy = jest.spyOn(service, 'postTransaction').mockResolvedValue({ id: 'rev1' } as any);

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
        'tx1'
      );
    });

    it('should prevent double reversal', async () => {
      mockPrisma.ledgerTransaction.findUnique.mockResolvedValue({
        ...originalTx,
        reversals: [{ id: 'rev_already' }],
      });

      await expect(service.reverseTransaction('tx1', 'reason', 'REFUND')).rejects.toThrow(BadRequestException);
    });
  });
});
