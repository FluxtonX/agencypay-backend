import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service.js';

@Module({
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
