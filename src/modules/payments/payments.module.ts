import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { CreditController } from './credit.controller.js';
import { ExcelController } from './excel.controller.js';
import { SplitEngine } from './orchestrator/split-engine.service.js';
import { CreditEngine } from './orchestrator/credit-engine.service.js';
import { RiskAssessmentService } from './orchestrator/risk-assessment.service.js';
import { IdempotencyService } from '../../common/utils/idempotency.service.js';
import { LedgerModule } from '../ledger/ledger.module.js';

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController, CreditController, ExcelController],
  providers: [
    PaymentsService,
    SplitEngine,
    CreditEngine,
    RiskAssessmentService,
    IdempotencyService,
  ],
  exports: [PaymentsService, SplitEngine, CreditEngine, RiskAssessmentService],
})
export class PaymentsModule {}

