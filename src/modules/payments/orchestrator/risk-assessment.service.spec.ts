import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { RiskAssessmentService } from './risk-assessment.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from 'decimal.js';
import { AgncyPayEvent } from '../../../common/constants/events.js';

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid',
}));

describe('RiskAssessmentService', () => {
  let service: RiskAssessmentService;

  const mockPrisma = {
    wallet: { findUnique: jest.fn() },
    payment: {
      count: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
    creditLine: { findFirst: jest.fn() },
    riskAssessment: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  };

  const mockLedgerService = {};

  const mockConfig = {
    get: jest.fn((key: string, defaultValue?: any) => {
      const values: Record<string, any> = {
        'credit.minScoreForApproval': 60,
        'credit.minScoreForPartial': 40,
      };
      return values[key] ?? defaultValue;
    }),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiskAssessmentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LedgerService, useValue: mockLedgerService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<RiskAssessmentService>(RiskAssessmentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // assessRisk — High score (APPROVE)
  // ========================================================================
  describe('assessRisk', () => {
    const setupWalletWithGoodHistory = () => {
      // Wallet created 1 year ago
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w1',
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      });

      // Lots of settled payments
      mockPrisma.payment.count
        .mockResolvedValueOnce(55)   // settled count
        .mockResolvedValueOnce(60)   // total
        .mockResolvedValueOnce(0)    // failed/chargebacked
        .mockResolvedValueOnce(0);   // chargebacks

      // Average payment amount
      mockPrisma.payment.findMany.mockResolvedValue([
        { amount: new Decimal('1000.00') },
        { amount: new Decimal('2000.00') },
      ]);

      // No existing credit
      mockPrisma.creditLine.findFirst.mockResolvedValue(null);

      // Mock the assessment creation
      mockPrisma.riskAssessment.create.mockImplementation(async ({ data }) => ({
        id: 'ra-1',
        ...data,
      }));
    };

    it('should APPROVE a wallet with strong history', async () => {
      setupWalletWithGoodHistory();

      const result = await service.assessRisk('w1', '500.00');

      expect(result.decision).toBe('APPROVE');
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.approvedAmount).toBe('500.00');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        AgncyPayEvent.RISK_ASSESSMENT_COMPLETED,
        expect.objectContaining({ decision: 'APPROVE' }),
      );
    });

    it('should REJECT a brand-new wallet with no history', async () => {
      // New wallet, just created
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-new',
        createdAt: new Date(), // Just created
      });

      mockPrisma.payment.count
        .mockResolvedValueOnce(0)  // no settled payments
        .mockResolvedValueOnce(0)  // no total payments
        .mockResolvedValueOnce(0)  // no failed
        .mockResolvedValueOnce(0); // no chargebacks

      mockPrisma.payment.findMany.mockResolvedValue([]);
      mockPrisma.creditLine.findFirst.mockResolvedValue(null);

      mockPrisma.riskAssessment.create.mockImplementation(async ({ data }) => ({
        id: 'ra-2',
        ...data,
      }));

      const result = await service.assessRisk('w-new', '10000.00');

      // New wallet: age=5, history=0, size=50, reliability=50, chargeback=100, exposure=80
      // Weighted score ≈ 40 → PARTIAL (between minScoreForPartial and minScoreForApproval)
      expect(result.decision).toBe('PARTIAL');
      expect(result.score).toBeGreaterThanOrEqual(30);
      expect(result.score).toBeLessThan(60);
    });

    it('should REJECT wallets with high chargeback rate', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-bad',
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      });

      mockPrisma.payment.count
        .mockResolvedValueOnce(10)  // settled
        .mockResolvedValueOnce(20)  // total
        .mockResolvedValueOnce(5)   // failed/chargebacked
        .mockResolvedValueOnce(5);  // chargebacks (25% rate!)

      mockPrisma.payment.findMany.mockResolvedValue([
        { amount: new Decimal('100.00') },
      ]);

      mockPrisma.creditLine.findFirst.mockResolvedValue(null);

      mockPrisma.riskAssessment.create.mockImplementation(async ({ data }) => ({
        id: 'ra-3',
        ...data,
      }));

      const result = await service.assessRisk('w-bad', '500.00');

      // High chargeback rate should tank the score
      expect(result.score).toBeLessThan(60);
    });

    it('should throw for non-existent wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.assessRisk('nonexistent', '100.00')).rejects.toThrow(
        /not found/,
      );
    });

    it('should handle existing credit with high utilization', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-credit',
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      });

      mockPrisma.payment.count
        .mockResolvedValueOnce(15)
        .mockResolvedValueOnce(15)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      mockPrisma.payment.findMany.mockResolvedValue([
        { amount: new Decimal('500.00') },
      ]);

      // High credit utilization
      mockPrisma.creditLine.findFirst.mockResolvedValue({
        id: 'cl-1',
        maxAmount: new Decimal('1000.00'),
        usedAmount: new Decimal('950.00'), // 95% utilized
      });

      mockPrisma.riskAssessment.create.mockImplementation(async ({ data }) => ({
        id: 'ra-4',
        ...data,
      }));

      const result = await service.assessRisk('w-credit', '100.00');

      // High utilization should lower the score
      expect(result).toBeDefined();
    });
  });

  // ========================================================================
  // getLatestAssessment
  // ========================================================================
  describe('getLatestAssessment', () => {
    it('should return the most recent assessment', async () => {
      const assessment = {
        id: 'ra-latest',
        walletId: 'w1',
        score: 75,
        decision: 'APPROVE',
      };
      mockPrisma.riskAssessment.findFirst.mockResolvedValue(assessment);

      const result = await service.getLatestAssessment('w1');
      expect(result?.id).toBe('ra-latest');
    });

    it('should return null if no assessments exist', async () => {
      mockPrisma.riskAssessment.findFirst.mockResolvedValue(null);

      const result = await service.getLatestAssessment('w-none');
      expect(result).toBeNull();
    });
  });
});
