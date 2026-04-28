import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.js';
import type { ReconciliationStatus } from '@prisma/client';

@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
  ) {}

  @Post('payment/:paymentId')
  @HttpCode(HttpStatus.OK)
  async reconcilePayment(@Param('paymentId') paymentId: string) {
    const result =
      await this.reconciliationService.reconcilePayment(paymentId);
    return { success: true, data: result };
  }

  @Post('payout/:payoutId')
  @HttpCode(HttpStatus.OK)
  async reconcilePayout(@Param('payoutId') payoutId: string) {
    const result =
      await this.reconciliationService.reconcilePayout(payoutId);
    return { success: true, data: result };
  }

  @Post('audit/global')
  @HttpCode(HttpStatus.OK)
  async globalAudit() {
    const result =
      await this.reconciliationService.auditGlobalLedgerBalance();
    return { success: true, data: result };
  }

  @Get()
  async listReconciliations(
    @Query('entityType') entityType?: string,
    @Query('status') status?: ReconciliationStatus,
    @Query('limit') limit?: string,
  ) {
    const results = await this.reconciliationService.getReconciliations(
      entityType,
      status,
      limit ? parseInt(limit, 10) : 20,
    );
    return { success: true, data: results };
  }
}
