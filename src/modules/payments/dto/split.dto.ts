import { IsString, IsArray, ValidateNested, IsOptional, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

export class SplitParticipantDto {
  @IsString()
  walletId: string;

  @IsString()
  ratio: string; // Decimal string (e.g., "0.70" for 70%)

  @IsOptional()
  @IsString()
  description?: string;
}

export class SplitInvoiceDto {
  @IsString()
  invoiceId: string;

  @IsString()
  totalAmount: string; // Decimal string

  @IsString()
  currency: string;

  @IsString()
  payerWalletId: string; // Who is paying

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SplitParticipantDto)
  participants: SplitParticipantDto[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  platformFeeRatio?: string; // Platform's cut (e.g., "0.025" for 2.5%)

  @IsOptional()
  @IsString()
  platformWalletId?: string;
}

export interface ComputedSplitEntry {
  walletId: string;
  accountId: string;
  amount: string;
  description: string;
}

export interface SplitResult {
  invoiceId: string;
  totalAmount: string;
  currency: string;
  entries: ComputedSplitEntry[];
  platformFee?: ComputedSplitEntry;
}
