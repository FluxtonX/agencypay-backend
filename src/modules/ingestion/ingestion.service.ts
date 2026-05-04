import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { QuickBooksMapper } from './mappers/quickbooks.mapper.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { NormalizedInvoice } from '../../integrations/quickbooks/quickbooks.service.js';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qbMapper: QuickBooksMapper,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Process an ingested invoice from QuickBooks.
   * 1. Resolve or create a Wallet for the customer.
   * 2. Upsert the Invoice and its LineItems.
   * 3. Return the processed Invoice.
   */
  async ingestQuickBooksInvoice(qbInvoice: NormalizedInvoice, realmId: string) {
    this.logger.log(`Ingesting QB invoice: ${qbInvoice.invoiceNumber} (Realm: ${realmId})`);

    // 1. Resolve the wallet for this external entity
    // In a real scenario, realmId + customerId maps to a specific Agency wallet
    let wallet = await this.walletService.resolveWalletByExternalId('quickbooks', qbInvoice.customerId);

    if (!wallet) {
      this.logger.warn(`Wallet not found for QB customer ${qbInvoice.customerId}. Creating placeholder...`);
      // For demo purposes, we create a wallet if not found. 
      // In production, this might trigger an onboarding flow or lookup.
      wallet = await this.walletService.createWallet({
        name: qbInvoice.customerName,
        type: 'BUSINESS',
        email: `${qbInvoice.customerId}@quickbooks.temp`,
        metadata: { qbCustomerId: qbInvoice.customerId, realmId },
      });

      await this.walletService.mapExternalAccount({
        walletId: wallet.id,
        provider: 'quickbooks',
        externalId: qbInvoice.customerId,
        externalType: 'customer',
      });
    }

    // 2. Upsert the Invoice (Idempotency check via externalId)
    const invoiceData = this.qbMapper.mapToInternalInvoice(qbInvoice, wallet.id);

    const invoice = await this.prisma.invoice.upsert({
      where: {
        walletId_externalId: {
          walletId: wallet.id,
          externalId: qbInvoice.externalId,
        },
      },
      update: {
        status: invoiceData.status,
        amount: invoiceData.amount,
        dueDate: invoiceData.dueDate,
        metadata: invoiceData.metadata as any,
      },
      create: {
        ...invoiceData,
        metadata: invoiceData.metadata as any,
      } as any,
      include: { lineItems: true },
    });

    this.logger.log(`Successfully ingested invoice ${invoice.id} for wallet ${wallet.id}`);
    return invoice;
  }
}
