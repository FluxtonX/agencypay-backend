import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service.js';
import { PayoutsController } from './payouts.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ColumnModule } from '../../integrations/column/column.module.js';
import { IdempotencyService } from '../../common/utils/idempotency.service.js';

@Module({
  imports: [LedgerModule, ColumnModule],
  controllers: [PayoutsController],
  providers: [PayoutsService, IdempotencyService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
