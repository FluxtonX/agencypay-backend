import { Module } from '@nestjs/common';
import { EventConsumer } from './event.consumer.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';

@Module({
  imports: [IngestionModule],
  providers: [EventConsumer],
  exports: [EventConsumer],
})
export class EventsModule {}
