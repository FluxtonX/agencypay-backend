import { Module } from '@nestjs/common';
import { ColumnBankAdapter } from './column.service.js';

@Module({
  providers: [ColumnBankAdapter],
  exports: [ColumnBankAdapter],
})
export class ColumnModule {}
