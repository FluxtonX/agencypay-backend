import { Module, Global } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { ScheduleModule } from '@nestjs/schedule';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
