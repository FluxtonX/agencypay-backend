import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { QuickBooksModule } from '../../integrations/quickbooks/quickbooks.module.js';

@Module({
  imports: [QuickBooksModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
