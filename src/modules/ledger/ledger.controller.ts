import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import type { PostTransactionDto } from './dto/ledger.dto.js';

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  /**
   * POST /ledger/transactions
   * Post a balanced ledger transaction.
   */
  @Post('transactions')
  @HttpCode(HttpStatus.CREATED)
  async postTransaction(@Body() dto: PostTransactionDto) {
    const transaction = await this.ledgerService.postTransaction(dto);
    return {
      success: true,
      data: transaction,
    };
  }

  /**
   * GET /ledger/accounts/:walletId
   * Get all accounts for a wallet.
   */
  @Get('accounts/:walletId')
  async getAccountsByWallet(
    @Param('walletId') walletId: string,
    @Query('currency') currency?: string,
  ) {
    const accounts = await this.ledgerService.getAccountsByWallet(
      walletId,
      currency,
    );
    return { success: true, data: accounts };
  }

  /**
   * GET /ledger/balance/:accountId
   * Compute balance from ledger entries (never cached).
   */
  @Get('balance/:accountId')
  async getBalance(
    @Param('accountId') accountId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    const balance = await this.ledgerService.computeBalanceFromLedger(
      accountId,
      asOfDate ? new Date(asOfDate) : undefined,
    );
    return {
      success: true,
      data: {
        accountId,
        balance: balance.toFixed(4),
        computedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * GET /ledger/wallet-balances/:walletId
   * Compute all account balances for a wallet.
   */
  @Get('wallet-balances/:walletId')
  async getWalletBalances(
    @Param('walletId') walletId: string,
    @Query('currency') currency?: string,
  ) {
    const balances = await this.ledgerService.computeWalletBalances(
      walletId,
      currency || 'USD',
    );

    const data: Record<string, string> = {};
    for (const [type, balance] of balances) {
      data[type] = balance.toFixed(4);
    }

    return {
      success: true,
      data: {
        walletId,
        currency: currency || 'USD',
        balances: data,
        computedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * GET /ledger/entries/:accountId
   * Get ledger entries for an account.
   */
  @Get('entries/:accountId')
  async getEntries(
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const entries = await this.ledgerService.getEntriesByAccount(
      accountId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
    return { success: true, data: entries };
  }

  /**
   * GET /ledger/transactions/:referenceId
   * Get transactions by reference.
   */
  @Get('transactions/:referenceId')
  async getTransactions(
    @Param('referenceId') referenceId: string,
    @Query('referenceType') referenceType: string,
  ) {
    const transactions = await this.ledgerService.getTransactionsByReference(
      referenceId,
      referenceType,
    );
    return { success: true, data: transactions };
  }

  /**
   * POST /ledger/reverse/:transactionId
   * Reverse a posted transaction.
   */
  @Post('reverse/:transactionId')
  @HttpCode(HttpStatus.CREATED)
  async reverseTransaction(
    @Param('transactionId') transactionId: string,
    @Body() body: { reason: string; type: 'REFUND' | 'CHARGEBACK' | 'ADJUSTMENT' },
  ) {
    const reversal = await this.ledgerService.reverseTransaction(
      transactionId,
      body.reason,
      body.type,
    );
    return { success: true, data: reversal };
  }
}
