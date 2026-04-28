import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { PayoutsService } from './payouts.service.js';
import type { InitiatePayoutDto, PayoutWebhookDto } from './dto/payout.dto.js';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async initiatePayout(
    @Body() dto: InitiatePayoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency-Key header is required for payout operations',
      );
    }

    const payout = await this.payoutsService.initiatePayout(
      dto,
      idempotencyKey,
    );
    return { success: true, data: payout };
  }

  @Post('webhook/bank')
  @HttpCode(HttpStatus.OK)
  async handleBankWebhook(@Body() dto: PayoutWebhookDto) {
    const payout = await this.payoutsService.handleBankWebhook(dto);
    return { success: true, data: payout };
  }

  @Get(':payoutId')
  async getPayout(@Param('payoutId') payoutId: string) {
    const payout = await this.payoutsService.getPayout(payoutId);
    return { success: true, data: payout };
  }

  @Get('wallet/:walletId')
  async listPayoutsByWallet(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const payouts = await this.payoutsService.listPayoutsByWallet(
      walletId,
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return { success: true, data: payouts };
  }
}
