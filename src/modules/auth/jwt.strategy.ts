import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload, AuthenticatedUser } from '../../common/constants/roles.js';

/**
 * JWT Strategy — validates Bearer tokens from the Authorization header.
 *
 * In production, configure JWT_SECRET via environment variable.
 * For asymmetric signing (RS256), replace `secretOrKey` with a public key.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('auth.jwtSecret', 'agncypay-dev-secret-change-in-production'),
    });
  }

  /**
   * Called after token is verified. Return value is attached to request.user.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    return {
      userId: payload.sub,
      email: payload.email,
      roles: payload.roles || [],
      walletId: payload.walletId,
    };
  }
}
