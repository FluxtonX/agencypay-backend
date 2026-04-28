import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { CreditController } from './credit.controller.js';
import { SplitEngine } from './orchestrator/split-engine.service.js';
import { CreditEngine } from './orchestrator/credit-engine.service.js';
import { RiskAssessmentService } from './orchestrator/risk-assessment.service.js';
import { LedgerModule } from '../ledger/ledger.module.js';

@Module({
  imports: [LedgerModule],
  controllers: [PaymentsController, CreditController],
  providers: [
    PaymentsService,
    SplitEngine,
    CreditEngine,
    RiskAssessmentService,
  ],
  exports: [PaymentsService, SplitEngine, CreditEngine, RiskAssessmentService],
})
export class PaymentsModule {}
