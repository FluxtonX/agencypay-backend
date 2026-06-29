import { Module } from '@nestjs/common';
import { XeroService } from './xero.service.js';
import { XeroController } from './xero.controller.js';
import { TokenStorageService } from '../token-storage.service.js';

@Module({
  controllers: [XeroController],
  providers: [XeroService, TokenStorageService],
  exports: [XeroService],
})
export class XeroModule {}
