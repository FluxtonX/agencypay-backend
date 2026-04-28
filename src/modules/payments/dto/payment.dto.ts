import { IsString, IsOptional, IsObject, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { SplitParticipantDto } from './split.dto.js';

export class IngestPaymentDto {
  @IsString()
  externalId: string;

  @IsString()
  source: 'QUICKBOOKS' | 'API' | 'MANUAL';

  @IsString()
  walletId: string;

  @IsString()
  amount: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  invoiceId?: string;

  @IsOptional()
  @IsObject()
  invoiceData?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  splitConfig?: {
    participants: { walletId: string; ratio: string; description?: string }[];
    platformFeeRatio?: string;
    platformWalletId?: string;
  };

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RefundPaymentDto {
  @IsString()
  paymentId: string;

  @IsOptional()
  @IsString()
  amount?: string; // Partial refund amount; if absent, full refund

  @IsString()
  reason: string;
}

export class ChargebackPaymentDto {
  @IsString()
  paymentId: string;

  @IsString()
  reason: string;

  @IsOptional()
  @IsString()
  amount?: string;
}
