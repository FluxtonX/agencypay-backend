import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

export interface ACHTransferRequest {
  payoutId: string;
  amount: string;
  currency: string;
  bankAccountInfo: Record<string, unknown>;
}

export interface ACHTransferResult {
  transferId: string;
  status: 'submitted' | 'failed';
  estimatedSettlement?: string;
}

export interface ACHWebhookPayload {
  transferId: string;
  status: 'completed' | 'failed' | 'returned';
  failureReason?: string;
  completedAt?: string;
}

/**
 * Column Bank Adapter — Mock implementation for ACH transfers.
 *
 * In production, this would call the Column API:
 * - POST /transfers/ach to initiate
 * - Webhook handler for settlement/failure notifications
 *
 * Currently simulates success with a realistic response structure.
 */
@Injectable()
export class ColumnBankAdapter {
  private readonly logger = new Logger(ColumnBankAdapter.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Initiate an ACH bank transfer.
   * MOCK: Simulates a successful submission.
   */
  async initiateACHTransfer(
    request: ACHTransferRequest,
  ): Promise<ACHTransferResult> {
    const apiKey = this.config.get<string>('column.apiKey', '');
    const baseUrl = this.config.get<string>(
      'column.baseUrl',
      'https://api.column.com',
    );

    this.logger.log(
      `[MOCK] Initiating ACH transfer: ${request.amount} ${request.currency} ` +
        `for payout ${request.payoutId}`,
    );

    // In production, this would be:
    // const response = await fetch(`${baseUrl}/transfers/ach`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${apiKey}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     amount: request.amount,
    //     currency: request.currency,
    //     counterparty_id: request.bankAccountInfo.counterpartyId,
    //     description: `AgncyPay Payout ${request.payoutId}`,
    //     type: 'credit', // Sending money to the recipient
    //   }),
    // });

    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    const transferId = `col_ach_${uuidv4().slice(0, 12)}`;

    // Simulate occasional failures (5% rate for testing)
    const shouldFail = Math.random() < 0.05;

    if (shouldFail) {
      this.logger.warn(
        `[MOCK] ACH transfer failed for payout ${request.payoutId}`,
      );
      return {
        transferId,
        status: 'failed',
      };
    }

    const estimatedSettlement = new Date(
      Date.now() + 2 * 24 * 60 * 60 * 1000,
    ).toISOString(); // T+2

    this.logger.log(
      `[MOCK] ACH transfer submitted: ${transferId}, estimated settlement: ${estimatedSettlement}`,
    );

    return {
      transferId,
      status: 'submitted',
      estimatedSettlement,
    };
  }

  /**
   * Verify a bank account (for production use).
   * MOCK: Always returns verified.
   */
  async verifyBankAccount(
    routingNumber: string,
    accountNumber: string,
  ): Promise<{ verified: boolean; accountName?: string }> {
    this.logger.log(`[MOCK] Verifying bank account: ****${accountNumber.slice(-4)}`);

    return {
      verified: true,
      accountName: 'Mock Account Holder',
    };
  }

  /**
   * Get transfer status.
   * MOCK: Returns based on random simulation.
   */
  async getTransferStatus(
    transferId: string,
  ): Promise<{ status: string; settledAt?: string }> {
    this.logger.log(`[MOCK] Checking transfer status: ${transferId}`);

    return {
      status: 'pending',
    };
  }
}
