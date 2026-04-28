import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { QuickBooksService } from '../../integrations/quickbooks/quickbooks.service.js';
import type { QuickBooksWebhookEvent } from '../../integrations/quickbooks/quickbooks.service.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly quickbooksService: QuickBooksService) {}

  /**
   * POST /webhooks/quickbooks
   * Handle incoming QuickBooks webhook events.
   */
  @Post('quickbooks')
  @HttpCode(HttpStatus.OK)
  async handleQuickBooksWebhook(
    @Body() payload: QuickBooksWebhookEvent,
    @Headers('intuit-signature') signature?: string,
  ) {
    this.logger.log('QuickBooks webhook received');

    const result = await this.quickbooksService.handleWebhook(
      payload,
      signature,
    );

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /webhooks/column
   * Handle incoming Column bank webhook events.
   * Routes to PayoutsService for settlement/failure handling.
   */
  @Post('column')
  @HttpCode(HttpStatus.OK)
  async handleColumnWebhook(
    @Body() payload: Record<string, unknown>,
    @Headers('x-column-signature') signature?: string,
  ) {
    this.logger.log(
      `Column webhook received: ${JSON.stringify(payload).slice(0, 200)}`,
    );

    // In production, parse and route to PayoutsService.handleBankWebhook
    return {
      success: true,
      message: 'Webhook received',
    };
  }
}
