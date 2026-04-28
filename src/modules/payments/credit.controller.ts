import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CreditEngine } from '../payments/orchestrator/credit-engine.service.js';
import { RiskAssessmentService } from '../payments/orchestrator/risk-assessment.service.js';

@Controller('credit')
export class CreditController {
  constructor(
    private readonly creditEngine: CreditEngine,
    private readonly riskService: RiskAssessmentService,
  ) {}

  /**
   * POST /credit/advance
   * Request a credit advance (early payout before settlement).
   */
  @Post('advance')
  @HttpCode(HttpStatus.CREATED)
  async requestAdvance(
    @Body()
    body: {
      walletId: string;
      amount: string;
      referenceId: string;
      currency?: string;
    },
  ) {
    const result = await this.creditEngine.requestCreditAdvance(
      body.walletId,
      body.amount,
      body.referenceId,
      body.currency,
    );
    return { success: true, data: result };
  }

  /**
   * GET /credit/line/:walletId
   * Get credit line details for a wallet.
   */
  @Get('line/:walletId')
  async getCreditLine(
    @Param('walletId') walletId: string,
    @Query('currency') currency?: string,
  ) {
    const creditLine = await this.creditEngine.getCreditLine(
      walletId,
      currency,
    );
    return { success: true, data: creditLine };
  }

  /**
   * POST /credit/freeze
   * Freeze a credit line.
   */
  @Post('freeze')
  @HttpCode(HttpStatus.OK)
  async freezeCreditLine(
    @Body() body: { walletId: string; reason: string; currency?: string },
  ) {
    const result = await this.creditEngine.freezeCreditLine(
      body.walletId,
      body.reason,
      body.currency,
    );
    return { success: true, data: result };
  }

  /**
   * POST /credit/risk-assess
   * Run a risk assessment for a wallet.
   */
  @Post('risk-assess')
  @HttpCode(HttpStatus.OK)
  async assessRisk(
    @Body() body: { walletId: string; requestedAmount: string },
  ) {
    const assessment = await this.riskService.assessRisk(
      body.walletId,
      body.requestedAmount,
    );
    return { success: true, data: assessment };
  }

  /**
   * GET /credit/risk/:walletId
   * Get latest risk assessment for a wallet.
   */
  @Get('risk/:walletId')
  async getLatestRiskAssessment(@Param('walletId') walletId: string) {
    const assessment = await this.riskService.getLatestAssessment(walletId);
    return { success: true, data: assessment };
  }
}
