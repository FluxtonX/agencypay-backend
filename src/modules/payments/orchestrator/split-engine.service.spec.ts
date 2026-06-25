import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { SplitEngine } from './split-engine.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { BadRequestException } from '@nestjs/common';
import { Decimal } from 'decimal.js';

describe('SplitEngine', () => {
  let service: SplitEngine;

  const mockPrisma = {};

  const mockLedgerService = {
    getAccountByType: jest.fn(),
    validateDoubleEntryInvariant: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SplitEngine,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LedgerService, useValue: mockLedgerService },
      ],
    }).compile();

    service = module.get<SplitEngine>(SplitEngine);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // computeSplitEntries — 2-way split
  // ========================================================================
  describe('computeSplitEntries', () => {
    it('should compute balanced 70/30 split', async () => {
      // Setup: payer has CASH, participants have PAYABLE
      mockLedgerService.getAccountByType
        .mockResolvedValueOnce({ id: 'payer-cash' })       // payer CASH
        .mockResolvedValueOnce({ id: 'walletA-payable' })  // participant A PAYABLE
        .mockResolvedValueOnce({ id: 'walletB-payable' }); // participant B PAYABLE

      const entries = await service.computeSplitEntries({
        invoiceId: 'inv-1',
        totalAmount: '1000.00',
        currency: 'USD',
        payerWalletId: 'payer-w',
        participants: [
          { walletId: 'walletA', ratio: '0.70' },
          { walletId: 'walletB', ratio: '0.30' },
        ],
      });

      // Should have 3 entries: 1 debit (payer) + 2 credits (participants)
      expect(entries).toHaveLength(3);

      // Payer debit should be +1000
      expect(entries[0].accountId).toBe('payer-cash');
      expect(entries[0].amount).toBe('1000.0000');

      // Participants should be negative (credits)
      const participant1Amount = parseFloat(entries[1].amount);
      const participant2Amount = parseFloat(entries[2].amount);
      expect(participant1Amount).toBeLessThan(0);
      expect(participant2Amount).toBeLessThan(0);

      // Validation should have been called
      expect(mockLedgerService.validateDoubleEntryInvariant).toHaveBeenCalled();
    });

    it('should handle platform fee extraction', async () => {
      mockLedgerService.getAccountByType
        .mockResolvedValueOnce({ id: 'payer-cash' })         // payer CASH
        .mockResolvedValueOnce({ id: 'platform-fee' })       // platform FEE
        .mockResolvedValueOnce({ id: 'walletA-payable' })    // participant A PAYABLE
        .mockResolvedValueOnce({ id: 'walletB-payable' });   // participant B PAYABLE

      const entries = await service.computeSplitEntries({
        invoiceId: 'inv-2',
        totalAmount: '1000.00',
        currency: 'USD',
        payerWalletId: 'payer-w',
        participants: [
          { walletId: 'walletA', ratio: '0.675' },
          { walletId: 'walletB', ratio: '0.300' },
        ],
        platformFeeRatio: '0.025', // 2.5% fee
        platformWalletId: 'platform-w',
      });

      // 4 entries: payer debit + fee credit + 2 participant credits
      expect(entries).toHaveLength(4);

      // Fee entry should be ~-25.00
      const feeEntry = entries.find((e) => e.accountId === 'platform-fee');
      expect(feeEntry).toBeDefined();
      expect(parseFloat(feeEntry!.amount)).toBeLessThan(0);
    });

    it('should throw if ratios do not sum to 1.0', async () => {
      await expect(
        service.computeSplitEntries({
          invoiceId: 'inv-3',
          totalAmount: '1000.00',
          currency: 'USD',
          payerWalletId: 'payer-w',
          participants: [
            { walletId: 'walletA', ratio: '0.50' },
            { walletId: 'walletB', ratio: '0.40' },
            // Sum = 0.90, not 1.0
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if payment exceeds invoice amount', async () => {
      mockLedgerService.getAccountByType.mockResolvedValue({ id: 'mock-acc' });

      await expect(
        service.computeSplitEntries(
          {
            invoiceId: 'inv-4',
            totalAmount: '100.00',
            currency: 'USD',
            payerWalletId: 'payer-w',
            participants: [
              { walletId: 'walletA', ratio: '1.0' },
            ],
          },
          '200.00', // Overpayment
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if payer has no CASH account', async () => {
      mockLedgerService.getAccountByType.mockResolvedValueOnce(null); // No CASH account

      await expect(
        service.computeSplitEntries({
          invoiceId: 'inv-5',
          totalAmount: '100.00',
          currency: 'USD',
          payerWalletId: 'payer-w',
          participants: [
            { walletId: 'walletA', ratio: '1.0' },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if participant has no PAYABLE account', async () => {
      mockLedgerService.getAccountByType
        .mockResolvedValueOnce({ id: 'payer-cash' }) // payer CASH
        .mockResolvedValueOnce(null);                 // participant has no PAYABLE

      await expect(
        service.computeSplitEntries({
          invoiceId: 'inv-6',
          totalAmount: '100.00',
          currency: 'USD',
          payerWalletId: 'payer-w',
          participants: [
            { walletId: 'walletA', ratio: '1.0' },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle partial payment (scaling down)', async () => {
      mockLedgerService.getAccountByType
        .mockResolvedValueOnce({ id: 'payer-cash' })
        .mockResolvedValueOnce({ id: 'walletA-payable' });

      const entries = await service.computeSplitEntries(
        {
          invoiceId: 'inv-7',
          totalAmount: '1000.00',
          currency: 'USD',
          payerWalletId: 'payer-w',
          participants: [
            { walletId: 'walletA', ratio: '1.0' },
          ],
        },
        '500.00', // 50% partial payment
      );

      expect(entries[0].amount).toBe('500.0000');  // Debit payer
      expect(entries[1].amount).toBe('-500.0000');  // Credit participant
    });
  });
});
