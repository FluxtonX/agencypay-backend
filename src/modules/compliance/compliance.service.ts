import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgncyPayEvent } from '../../common/constants/events.js';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Perform KYC/KYB screening for a wallet.
   * Integrates with Alloy and Sardine.
   */
  async screenWallet(walletId: string) {
    this.logger.log(`Performing compliance screening for wallet: ${walletId}`);

    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) throw new Error('Wallet not found');

    // MOCK: Integration calls to Alloy/Sardine
    const score = Math.floor(Math.random() * 100);
    const decision = score > 20 ? 'APPROVE' : 'REJECT';

    const assessment = await this.prisma.riskAssessment.create({
      data: {
        walletId,
        score,
        decision: decision as any,
        requestedAmount: '0', // Initial screening
        factors: {
          kycStatus: 'verified',
          amlCheck: 'pass',
          watchlistMatch: false,
        },
      },
    });

    this.eventEmitter.emit(AgncyPayEvent.RISK_ASSESSMENT_COMPLETED, {
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'ComplianceService',
      walletId,
      score,
      decision,
    });

    return assessment;
  }

  /**
   * Validate if a payout is permitted based on current compliance status.
   */
  async validatePayoutCompliance(walletId: string, amount: string) {
    const assessments = await this.prisma.riskAssessment.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    if (assessments.length === 0 || assessments[0].decision === 'REJECT') {
      return { permitted: false, reason: 'Compliance screening failed or missing' };
    }

    return { permitted: true };
  }
}
