import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { QuickBooksService } from '../../integrations/quickbooks/quickbooks.service.js';
import type { QuickBooksWebhookEvent } from '../../integrations/quickbooks/quickbooks.service.js';
import { PayoutsService } from '../payouts/payouts.service.js';

@Controller('webhooks')
@Public() // Webhooks use signature verification, not JWT
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly quickbooksService: QuickBooksService,
    private readonly payoutsService: PayoutsService,
  ) {}

  /**
   * POST /webhooks/quickbooks
   ... (unchanged)
   */

  /**
   * POST /webhooks/column
   * Handle incoming Column bank webhook events.
   * Routes to PayoutsService for settlement/failure handling.
   */
  @Post('column')
  @HttpCode(HttpStatus.OK)
  async handleColumnWebhook(
    @Body() payload: any,
    @Headers('x-column-signature') signature?: string,
  ) {
    this.logger.log(`Column webhook received: ${payload.type}`);

    // Map Column ACH transfer event to our internal structure
    if (payload.type === 'ach_transfer.updated' || payload.type === 'ach_transfer.created') {
      const transfer = payload.data;
      const statusMap: Record<string, 'SETTLED' | 'FAILED' | 'RETURNED'> = {
        'COMPLETED': 'SETTLED',
        'FAILED': 'FAILED',
        'RETURNED': 'RETURNED',
        'CANCELLED': 'FAILED',
      };

      const internalStatus = statusMap[transfer.status];
      
      if (internalStatus && transfer.external_id) {
        await this.payoutsService.handleBankWebhook({
          payoutId: transfer.external_id,
          status: internalStatus,
          bankReference: transfer.id,
          failureReason: transfer.failure_code || transfer.return_reason,
        });
      }
    }

    return { success: true };
  }
}
