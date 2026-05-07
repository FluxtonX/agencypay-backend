import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion.service.js';
import { IngestionController } from './ingestion.controller.js';
import { QuickBooksAuthController } from './quickbooks-auth.controller.js';
import { QuickBooksMapper } from './mappers/quickbooks.mapper.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { QuickBooksModule } from '../../integrations/quickbooks/quickbooks.module.js';

@Module({
  imports: [WalletModule, QuickBooksModule],
  controllers: [IngestionController, QuickBooksAuthController],
  providers: [IngestionService, QuickBooksMapper],
  exports: [IngestionService],
})
export class IngestionModule {}
