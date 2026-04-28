import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';

/**
 * Extract the Idempotency-Key header from the request.
 * Required for all mutating operations in a fintech system.
 */
export const IdempotencyKeyHeader = createParamDecorator(
  (required: boolean = true, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const key = request.headers['idempotency-key'] as string;

    if (required && !key) {
      throw new BadRequestException(
        'Idempotency-Key header is required for this operation',
      );
    }

    return key;
  },
);
