import { Module } from '@nestjs/common';
import { TokenStorageService } from './token-storage.service.js';

@Module({
  providers: [TokenStorageService],
  exports: [TokenStorageService],
})
export class TokenStorageModule {}
