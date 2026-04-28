import { IsString, IsEnum, IsOptional, IsDecimal, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import type { AccountType, TransactionType } from '@prisma/client';

export class LedgerEntryDto {
  @IsString()
  accountId: string;

  @IsString()
  amount: string; // String to preserve decimal precision

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class PostTransactionDto {
  @IsString()
  referenceId: string;

  @IsString()
  referenceType: string;

  @IsString()
  type: TransactionType;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LedgerEntryDto)
  entries: LedgerEntryDto[];
}

export class ComputeBalanceDto {
  @IsString()
  accountId: string;

  @IsOptional()
  @IsString()
  asOfDate?: string;
}

export class CreateAccountDto {
  @IsString()
  walletId: string;

  @IsString()
  type: AccountType;

  @IsOptional()
  @IsString()
  currency?: string;
}
