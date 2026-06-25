import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { WalletModule } from '../wallet/wallet.module.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('auth.jwtSecret', 'agncypay-dev-secret-change-in-production'),
        signOptions: {
          expiresIn: config.get<number>('auth.jwtExpirySeconds', 3600),
        },
      }),
      inject: [ConfigService],
    }),
    WalletModule,
  ],
  controllers: [AuthController],
  providers: [JwtStrategy, AuthService],
  exports: [JwtModule, PassportModule, AuthService],
})
export class AuthModule {}
