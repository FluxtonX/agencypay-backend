import { Module } from '@nestjs/common';
import { EventConsumer } from './event.consumer.js';

@Module({
  providers: [EventConsumer],
  exports: [EventConsumer],
})
export class EventsModule {}
