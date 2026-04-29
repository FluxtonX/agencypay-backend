import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to bypass JWT authentication on specific endpoints.
 * Usage: @Public() on webhook handlers, health checks, etc.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
