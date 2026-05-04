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
import { PaymentsService } from './payments.service.js';
import { IdempotencyKeyHeader } from '../../common/decorators/idempotency-key.decorator.js';
import {
  IngestPaymentDto,
  ListPaymentsByWalletQueryDto,
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
    @IdempotencyKeyHeader() idempotencyKey: string,
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
    @Query() query: ListPaymentsByWalletQueryDto,
  ) {
    const payments = await this.paymentsService.listPaymentsByWallet(
      walletId,
      query.limit ?? 20,
      query.offset ?? 0,
    );
    return { success: true, data: payments };
  }
}
