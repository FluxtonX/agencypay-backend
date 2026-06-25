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

  // ─── Invoice-specific routes (must be defined before /:paymentId) ───────────

  /**
   * List all payments that have an invoiceId attached (i.e. invoice payments)
   * for a specific wallet. Used in the dashboard invoices widget and invoices page.
   */
  @Get('invoices/wallet/:walletId')
  async listInvoicesByWallet(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const invoices = await this.paymentsService.listInvoicesByWallet(
      walletId,
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return { success: true, data: invoices };
  }

  /**
   * Dashboard preview — returns the 5 most recent invoice payments.
   * Optimised for the dashboard widget (no pagination needed).
   */
  @Get('invoices/wallet/:walletId/preview')
  async getDashboardInvoices(@Param('walletId') walletId: string) {
    const invoices = await this.paymentsService.getDashboardInvoices(walletId);
    return { success: true, data: invoices };
  }

  // ─── Generic payment routes ──────────────────────────────────────────────────

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

  @Get(':paymentId')
  async getPayment(@Param('paymentId') paymentId: string) {
    const payment = await this.paymentsService.getPayment(paymentId);
    return { success: true, data: payment };
  }
}
