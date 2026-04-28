import { IsString, IsOptional, IsObject } from 'class-validator';

export class InitiatePayoutDto {
  @IsString()
  walletId: string;

  @IsString()
  amount: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsObject()
  bankAccountInfo?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class PayoutWebhookDto {
  @IsString()
  payoutId: string;

  @IsString()
  bankReference: string;

  @IsString()
  status: 'SETTLED' | 'FAILED' | 'RETURNED';

  @IsOptional()
  @IsString()
  failureReason?: string;
}
