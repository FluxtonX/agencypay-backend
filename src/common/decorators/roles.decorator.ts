import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../constants/roles.js';

export const ROLES_KEY = 'roles';

/**
 * Decorator to restrict endpoint access to specific roles.
 * Usage: @Roles(UserRole.ADMIN, UserRole.PLATFORM)
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
