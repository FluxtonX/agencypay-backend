import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { QuickBooksService, QuickBooksWebhookEvent } from '../../integrations/quickbooks/quickbooks.service.js';
import { IngestionService } from './ingestion.service.js';

@Controller('ingestion')
export class IngestionController {
  private readonly logger = new Logger(IngestionController.name);

  constructor(
    private readonly qbService: QuickBooksService,
    private readonly ingestionService: IngestionService,
  ) {}

  /**
   * Endpoint for QuickBooks webhooks.
   * Dispatches events that are consumed by EventConsumer and processed by IngestionService.
   */
  @Post('webhooks/quickbooks')
  @HttpCode(HttpStatus.OK)
  async handleQuickBooksWebhook(
    @Body() payload: any,
    @Headers('intuit-signature') signature?: string,
  ) {
    this.logger.log(`Received QuickBooks webhook for ${payload.eventNotifications.length} notifications`);
    
    // handleWebhook validates signature and emits events like QUICKBOOKS_INVOICE_RECEIVED
    const result = await this.qbService.handleWebhook(payload, signature);
    
    return {
      success: true,
      processed: result.processed,
      skipped: result.skipped,
    };
  }
}
