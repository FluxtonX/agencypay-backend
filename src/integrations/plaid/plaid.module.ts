import { Module } from '@nestjs/common';
import { PlaidService } from './plaid.service.js';
import { PlaidController } from './plaid.controller.js';
import { TokenStorageModule } from '../token-storage.module.js';

@Module({
  imports: [TokenStorageModule],
  controllers: [PlaidController],
  providers: [PlaidService],
  exports: [PlaidService],
})
export class PlaidModule {}
