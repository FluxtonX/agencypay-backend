import { IsString, IsEnum, IsOptional, IsEmail, IsObject } from 'class-validator';
import type { WalletType } from '@prisma/client';

export class CreateWalletDto {
  @IsString()
  type: WalletType;

  @IsString()
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class MapExternalAccountDto {
  @IsString()
  walletId: string;

  @IsString()
  provider: string;

  @IsString()
  externalId: string;

  @IsOptional()
  @IsString()
  externalType?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class WalletBalanceResponseDto {
  walletId: string;
  name: string;
  currency: string;
  balances: Record<string, string>;
  computedAt: string;
}
