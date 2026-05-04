import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DbClient } from '../ledger/ledger.service.js';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Persist an event to the outbox table within an existing transaction.
   * This ensures the event is ONLY recorded if the business transaction succeeds.
   */
  async recordEvent(
    eventName: string,
    aggregateType: string,
    aggregateId: string,
    payload: any,
    tx: DbClient,
  ) {
    await (tx as any).outboxEvent.create({
      data: {
        eventName,
        aggregateType,
        aggregateId,
        payload: payload as any,
        status: 'PENDING',
      },
    });
  }

  /**
   * Background task: Poll for pending events and dispatch them to the internal bus.
   * In a multi-node production environment, this would use a distributed lock (Redis).
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async processOutbox() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pendingEvents = await this.prisma.outboxEvent.findMany({
        where: {
          status: { in: ['PENDING', 'FAILED'] },
          attempts: { lt: 5 },
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: new Date() } },
          ],
        },
        take: 50,
        orderBy: { createdAt: 'asc' },
      });

      if (pendingEvents.length === 0) {
        this.isProcessing = false;
        return;
      }

      this.logger.log(`Processing ${pendingEvents.length} outbox events...`);

      for (const event of pendingEvents) {
        try {
          // 1. Dispatch to the internal event bus
          // Consumers of these events are responsible for their own idempotency.
          await this.eventEmitter.emitAsync(event.eventName, event.payload);

          // 2. Mark as dispatched
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'DISPATCHED',
              dispatchedAt: new Date(),
              attempts: event.attempts + 1,
            },
          });
        } catch (error) {
          this.logger.error(`Failed to dispatch event ${event.id}: ${error.message}`);
          
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'FAILED',
              attempts: event.attempts + 1,
              nextAttemptAt: new Date(Date.now() + Math.pow(2, event.attempts) * 1000), // Exponential backoff
            },
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
