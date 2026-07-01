import { Module } from '@nestjs/common';
import { AgenciesService } from './agencies.service.js';
import { AgenciesController } from './agencies.controller.js';

@Module({
  controllers: [AgenciesController],
  providers: [AgenciesService],
  exports: [AgenciesService],
})
export class AgenciesModule {}
