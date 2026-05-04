import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { QuickBooksModule } from '../../integrations/quickbooks/quickbooks.module.js';
import { PayoutsModule } from '../payouts/payouts.module.js';

@Module({
  imports: [QuickBooksModule, PayoutsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
