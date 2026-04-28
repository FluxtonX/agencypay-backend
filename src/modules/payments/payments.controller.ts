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
} from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import type {
  IngestPaymentDto,
  RefundPaymentDto,
  ChargebackPaymentDto,
} from './dto/payment.dto.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async ingestPayment(
    @Body() dto: IngestPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const payment = await this.paymentsService.ingestPayment(
      dto,
      idempotencyKey,
    );
    return { success: true, data: payment };
  }

  @Post('refund')
  @HttpCode(HttpStatus.OK)
  async refundPayment(@Body() dto: RefundPaymentDto) {
    const payment = await this.paymentsService.refundPayment(dto);
    return { success: true, data: payment };
  }

  @Post('chargeback')
  @HttpCode(HttpStatus.OK)
  async handleChargeback(@Body() dto: ChargebackPaymentDto) {
    const payment = await this.paymentsService.handleChargeback(dto);
    return { success: true, data: payment };
  }

  @Get(':paymentId')
  async getPayment(@Param('paymentId') paymentId: string) {
    const payment = await this.paymentsService.getPayment(paymentId);
    return { success: true, data: payment };
  }

  @Get('wallet/:walletId')
  async listPaymentsByWallet(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const payments = await this.paymentsService.listPaymentsByWallet(
      walletId,
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return { success: true, data: payments };
  }
}
