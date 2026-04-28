import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';

export interface IdempotencyResult<T> {
  isNew: boolean;
  response?: T;
}

/**
 * Idempotency guard service.
 * Ensures that duplicate requests with the same key return the original response
 * without re-executing the operation. Critical for financial safety.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Check if an idempotency key has already been used.
   * If so, return the cached response. Otherwise, mark it as in-progress.
   */
  async check<T>(
    key: string,
    method: string,
    path: string,
  ): Promise<IdempotencyResult<T>> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      // Check if expired
      if (existing.expiresAt < new Date()) {
        // Key expired, delete and allow re-use
        await this.prisma.idempotencyKey.delete({ where: { key } });
        return { isNew: true };
      }

      // If the previous request completed, return cached response
      if (existing.response !== null && existing.statusCode !== null) {
        this.logger.log(`Idempotent response returned for key: ${key}`);
        return {
          isNew: false,
          response: existing.response as T,
        };
      }

      // Request is still in-progress (no response yet)
      throw new ConflictException(
        'A request with this idempotency key is already being processed',
      );
    }

    // Create the key to reserve it
    const ttlSeconds = this.config.get<number>('idempotency.ttlSeconds', 86400);
    await this.prisma.idempotencyKey.create({
      data: {
        key,
        method,
        path,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });

    return { isNew: true };
  }

  /**
   * Record the result of a completed operation for future idempotent responses.
   */
  async complete(
    key: string,
    statusCode: number,
    response: unknown,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        statusCode,
        response: response as any,
      },
    });
  }

  /**
   * Remove an idempotency key (e.g., if the operation failed and should be retryable).
   */
  async remove(key: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({ where: { key } });
  }
}
