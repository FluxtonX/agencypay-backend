/**
 * User roles for RBAC across AgncyPay.
 */
export enum UserRole {
  ADMIN = 'admin',
  PLATFORM = 'platform',     // System-level operations
  BRAND = 'brand',            // Brand users (payment initiators)
  AGENCY = 'agency',          // Agency users (split recipients)
  TALENT = 'talent',          // Talent users (payout recipients)
  SERVICE = 'service',        // Internal service-to-service calls
}

/**
 * JWT payload structure expected from the identity provider / API gateway.
 */
export interface JwtPayload {
  sub: string;            // User ID
  email?: string;
  roles: UserRole[];
  walletId?: string;      // Associated wallet (if any)
  iat?: number;
  exp?: number;
}

/**
 * Authenticated request user object (attached by JwtAuthGuard).
 */
export interface AuthenticatedUser {
  userId: string;
  email?: string;
  roles: UserRole[];
  walletId?: string;
}
