import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PaymentSplitParticipantDto {
  @IsString()
  walletId: string;

  @IsString()
  @Matches(/^(0(\.\d+)?|1(\.0+)?)$/)
  ratio: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class PaymentSplitConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentSplitParticipantDto)
  participants: PaymentSplitParticipantDto[];

  @IsOptional()
  @IsString()
  @Matches(/^(0(\.\d+)?|1(\.0+)?)$/)
  platformFeeRatio?: string;

  @IsOptional()
  @IsString()
  platformWalletId?: string;
}

export class IngestPaymentDto {
  @IsString()
  @IsOptional()
  externalId?: string;

  @IsString()
  @IsIn(['QUICKBOOKS', 'API', 'MANUAL'])
  source: 'QUICKBOOKS' | 'API' | 'MANUAL';

  @IsString()
  walletId: string;

  @IsString()
  @Matches(/^(?!0+(\.0{1,4})?$)\d+(\.\d{1,4})?$/)
  amount: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  invoiceId?: string;

  @IsOptional()
  @IsObject()
  invoiceData?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentSplitConfigDto)
  splitConfig?: PaymentSplitConfigDto;

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
  @Matches(/^(?!0+(\.0{1,4})?$)\d+(\.\d{1,4})?$/)
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
  @Matches(/^(?!0+(\.0{1,4})?$)\d+(\.\d{1,4})?$/)
  amount?: string;
}

export class ListPaymentsByWalletQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
