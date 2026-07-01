import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { QuickBooksModule } from '../../integrations/quickbooks/quickbooks.module.js';
import { XeroModule } from '../../integrations/xero/xero.module.js';

@Module({
  imports: [QuickBooksModule, XeroModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService]
})
export class ConnectionsModule {}
