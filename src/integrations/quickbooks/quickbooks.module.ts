import { Module } from '@nestjs/common';
import { QuickBooksService } from './quickbooks.service.js';
import { QuickBooksController } from './quickbooks.controller.js';
import { TokenStorageModule } from '../token-storage.module.js';

@Module({
  imports: [TokenStorageModule],
  controllers: [QuickBooksController],
  providers: [QuickBooksService],
  exports: [QuickBooksService],
})
export class QuickBooksModule {}
