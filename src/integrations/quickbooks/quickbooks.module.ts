import { Module } from '@nestjs/common';
import { QuickBooksService } from './quickbooks.service.js';
import { QuickBooksAuthService } from './quickbooks-auth.service.js';

@Module({
  providers: [QuickBooksService, QuickBooksAuthService],
  exports: [QuickBooksService, QuickBooksAuthService],
})
export class QuickBooksModule {}
